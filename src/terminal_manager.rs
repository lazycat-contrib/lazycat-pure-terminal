use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::sync::{Arc, Mutex, RwLock};
use std::thread;

use anyhow::{Context as AnyhowContext, anyhow};
use portable_pty::{CommandBuilder, MasterPty, NativePtySystem, PtySize, PtySystem};
use tokio::sync::broadcast;
use tracing::{info, warn};

use crate::validation::validate_size;

const EVENT_CAPACITY: usize = 1024;
const REPLAY_BYTE_LIMIT: usize = 1024 * 1024;

#[derive(Clone, Debug)]
pub struct TerminalSpec {
    pub session_id: String,
    pub host: String,
    pub selector: String,
    pub command: String,
    pub args: Vec<String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Debug)]
pub struct OutputFrame {
    pub data: Vec<u8>,
}

#[derive(Clone, Debug)]
pub struct ExitInfo {
    pub exit_code: i32,
    pub message: Option<String>,
}

#[derive(Clone, Debug)]
pub enum TerminalEvent {
    Output(OutputFrame),
    Exit(ExitInfo),
    Error(String),
}

pub struct TerminalRegistry {
    sessions: RwLock<HashMap<String, Arc<ManagedTerminal>>>,
}

impl TerminalRegistry {
    pub fn new() -> Self {
        Self {
            sessions: RwLock::new(HashMap::new()),
        }
    }

    pub fn open(
        &self,
        spec: TerminalSpec,
        allow_spawn: bool,
    ) -> anyhow::Result<Arc<ManagedTerminal>> {
        if let Some(existing) = self.existing(&spec.session_id)? {
            existing.resize(spec.cols, spec.rows)?;
            return Ok(existing);
        }

        if !allow_spawn {
            return Err(anyhow!("terminal process is not running"));
        }

        let mut sessions = self
            .sessions
            .write()
            .map_err(|_| anyhow!("terminal registry lock poisoned"))?;
        if let Some(existing) = sessions.get(&spec.session_id) {
            if existing.exit_info().is_some() {
                sessions.remove(&spec.session_id);
            } else {
                existing.resize(spec.cols, spec.rows)?;
                return Ok(Arc::clone(existing));
            }
        }

        let terminal = Arc::new(ManagedTerminal::spawn(spec)?);
        sessions.insert(terminal.session_id().to_owned(), Arc::clone(&terminal));
        Ok(terminal)
    }

    pub fn close(&self, session_id: &str) {
        let terminal = self
            .sessions
            .write()
            .ok()
            .and_then(|mut sessions| sessions.remove(session_id));
        if let Some(terminal) = terminal {
            terminal.close();
        }
    }

    pub fn forget(&self, session_id: &str) {
        if let Ok(mut sessions) = self.sessions.write() {
            sessions.remove(session_id);
        }
    }

    fn existing(&self, session_id: &str) -> anyhow::Result<Option<Arc<ManagedTerminal>>> {
        let sessions = self
            .sessions
            .read()
            .map_err(|_| anyhow!("terminal registry lock poisoned"))?;
        let Some(existing) = sessions.get(session_id) else {
            return Ok(None);
        };
        if existing.exit_info().is_some() {
            return Ok(None);
        }
        Ok(Some(Arc::clone(existing)))
    }
}

pub struct ManagedTerminal {
    session_id: String,
    selector: String,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer_tx: std::sync::mpsc::Sender<WriterCommand>,
    event_tx: broadcast::Sender<TerminalEvent>,
    killer: Mutex<Option<Box<dyn portable_pty::ChildKiller + Send + Sync>>>,
    output: Arc<OutputBuffer>,
    exit: Arc<Mutex<Option<ExitInfo>>>,
}

impl ManagedTerminal {
    fn spawn(spec: TerminalSpec) -> anyhow::Result<Self> {
        validate_size(spec.cols, spec.rows)?;
        if spec.command.trim().is_empty() {
            return Err(anyhow!("terminal command must not be empty"));
        }
        info!(
            session_id = %spec.session_id,
            host = %spec.host,
            selector = %spec.selector,
            command = %spec.command,
            "spawning terminal session"
        );
        let pty_system = NativePtySystem::default();
        let pair = pty_system.openpty(PtySize {
            rows: spec.rows,
            cols: spec.cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let mut command = CommandBuilder::new(&spec.command);
        for arg in &spec.args {
            command.arg(arg);
        }
        command.env("TERM", "xterm-256color");

        let mut child = pair
            .slave
            .spawn_command(command)
            .with_context(|| format!("failed to start {}", spec.command))?;
        let killer = child.clone_killer();
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader()?;
        let mut writer = pair.master.take_writer()?;
        let (writer_tx, writer_rx) = std::sync::mpsc::channel::<WriterCommand>();
        let (event_tx, _) = broadcast::channel::<TerminalEvent>(EVENT_CAPACITY);
        let output = Arc::new(OutputBuffer::default());
        let exit = Arc::new(Mutex::new(None));

        let output_tx = event_tx.clone();
        let output_buffer = Arc::clone(&output);
        thread::spawn(move || {
            let mut buf = [0_u8; 8192];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let frame = output_buffer.push(buf[..n].to_vec());
                        let _ = output_tx.send(TerminalEvent::Output(frame));
                    }
                    Err(err) => {
                        let _ = output_tx.send(TerminalEvent::Error(err.to_string()));
                        break;
                    }
                }
            }
        });

        thread::spawn(move || {
            for command in writer_rx {
                match command {
                    WriterCommand::Input(data) => {
                        if let Err(err) = writer.write_all(&data) {
                            warn!(error = %err, "failed to write terminal input");
                            break;
                        }
                        if let Err(err) = writer.flush() {
                            warn!(error = %err, "failed to flush terminal input");
                            break;
                        }
                    }
                    WriterCommand::Close => break,
                }
            }
        });

        let exit_tx = event_tx.clone();
        let exit_state = Arc::clone(&exit);
        thread::spawn(move || {
            let result = child.wait();
            let info = match result {
                Ok(status) => ExitInfo {
                    exit_code: i32::try_from(status.exit_code()).unwrap_or(i32::MAX),
                    message: status.signal().map(ToOwned::to_owned),
                },
                Err(err) => ExitInfo {
                    exit_code: -1,
                    message: Some(err.to_string()),
                },
            };
            if let Ok(mut exit) = exit_state.lock() {
                *exit = Some(info.clone());
            }
            let _ = exit_tx.send(TerminalEvent::Exit(info));
        });

        Ok(Self {
            session_id: spec.session_id,
            selector: spec.selector,
            master: Mutex::new(pair.master),
            writer_tx,
            event_tx,
            killer: Mutex::new(Some(killer)),
            output,
            exit,
        })
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn selector(&self) -> &str {
        &self.selector
    }

    pub fn subscribe(&self) -> broadcast::Receiver<TerminalEvent> {
        self.event_tx.subscribe()
    }

    pub fn replay_snapshot(&self) -> (Vec<OutputFrame>, u64) {
        self.output.snapshot()
    }

    pub fn exit_info(&self) -> Option<ExitInfo> {
        self.exit.lock().ok().and_then(|exit| exit.clone())
    }

    pub fn write_input(&self, data: Vec<u8>) {
        let _ = self.writer_tx.send(WriterCommand::Input(data));
    }

    pub fn resize(&self, cols: u16, rows: u16) -> anyhow::Result<()> {
        validate_size(cols, rows)?;
        let master = self
            .master
            .lock()
            .map_err(|_| anyhow!("pty lock poisoned"))?;
        master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    fn close(&self) {
        let _ = self.writer_tx.send(WriterCommand::Close);
        let Some(mut child_killer) = self.killer.lock().ok().and_then(|mut killer| killer.take())
        else {
            return;
        };
        if let Err(err) = child_killer.kill() {
            warn!(error = %err, "terminal child was already closed");
        }
    }
}

impl Drop for ManagedTerminal {
    fn drop(&mut self) {
        self.close();
    }
}

enum WriterCommand {
    Input(Vec<u8>),
    Close,
}

#[derive(Default)]
struct OutputBuffer {
    inner: Mutex<OutputBufferInner>,
}

#[derive(Default)]
struct OutputBufferInner {
    frames: VecDeque<OutputFrame>,
    total_bytes: usize,
}

impl OutputBuffer {
    fn push(&self, data: Vec<u8>) -> OutputFrame {
        let mut inner = self.inner.lock().expect("terminal output buffer poisoned");
        inner.total_bytes = inner.total_bytes.saturating_add(data.len());
        let frame = OutputFrame { data };
        inner.frames.push_back(frame.clone());
        while inner.total_bytes > REPLAY_BYTE_LIMIT {
            let Some(removed) = inner.frames.pop_front() else {
                break;
            };
            inner.total_bytes = inner.total_bytes.saturating_sub(removed.data.len());
        }
        frame
    }

    fn snapshot(&self) -> (Vec<OutputFrame>, u64) {
        let inner = self.inner.lock().expect("terminal output buffer poisoned");
        (inner.frames.iter().cloned().collect(), 0)
    }
}
