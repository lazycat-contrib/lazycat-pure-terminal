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
    pub sequence: u64,
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

        let terminal = Arc::new(ManagedTerminal::spawn(spec)?);

        let mut sessions = self
            .sessions
            .write()
            .map_err(|_| anyhow!("terminal registry lock poisoned"))?;
        if let Some(existing) = sessions.get(terminal.session_id()) {
            if existing.exit_info().is_some() {
                sessions.remove(terminal.session_id());
            } else {
                existing.resize(terminal.cols(), terminal.rows())?;
                return Ok(Arc::clone(existing));
            }
        }

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
    cols: u16,
    rows: u16,
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

        let child = pair
            .slave
            .spawn_command(command)
            .with_context(|| format!("failed to start {}", spec.command))?;
        let killer = child.clone_killer();
        drop(pair.slave);

        let reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let (writer_tx, writer_rx) = std::sync::mpsc::channel::<WriterCommand>();
        let (event_tx, _) = broadcast::channel::<TerminalEvent>(EVENT_CAPACITY);
        let output = Arc::new(OutputBuffer::default());
        let exit = Arc::new(Mutex::new(None));

        spawn_output_thread(reader, event_tx.clone(), Arc::clone(&output));
        spawn_writer_thread(writer, writer_rx);
        spawn_exit_thread(child, event_tx.clone(), Arc::clone(&exit));

        Ok(Self {
            session_id: spec.session_id,
            selector: spec.selector,
            cols: spec.cols,
            rows: spec.rows,
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

    fn cols(&self) -> u16 {
        self.cols
    }

    fn rows(&self) -> u16 {
        self.rows
    }

    pub fn subscribe(&self) -> broadcast::Receiver<TerminalEvent> {
        self.event_tx.subscribe()
    }

    pub fn replay_snapshot_after(&self, sequence: u64) -> (Vec<OutputFrame>, u64) {
        self.output.snapshot_after(sequence)
    }

    pub fn exit_info(&self) -> Option<ExitInfo> {
        self.exit.lock().ok().and_then(|exit| exit.clone())
    }

    pub fn write_input(&self, data: Vec<u8>) -> anyhow::Result<()> {
        self.writer_tx
            .send(WriterCommand::Input(data))
            .map_err(|_| anyhow!("terminal input writer is closed"))
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

fn spawn_output_thread(
    mut reader: Box<dyn Read + Send>,
    event_tx: broadcast::Sender<TerminalEvent>,
    output: Arc<OutputBuffer>,
) {
    thread::spawn(move || {
        let mut buf = [0_u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let frame = output.push(buf[..n].to_vec());
                    let _ = event_tx.send(TerminalEvent::Output(frame));
                }
                Err(err) => {
                    let _ = event_tx.send(TerminalEvent::Error(err.to_string()));
                    break;
                }
            }
        }
    });
}

fn spawn_writer_thread(
    mut writer: Box<dyn Write + Send>,
    writer_rx: std::sync::mpsc::Receiver<WriterCommand>,
) {
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
}

fn spawn_exit_thread(
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    event_tx: broadcast::Sender<TerminalEvent>,
    exit: Arc<Mutex<Option<ExitInfo>>>,
) {
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
        if let Ok(mut exit) = exit.lock() {
            *exit = Some(info.clone());
        }
        let _ = event_tx.send(TerminalEvent::Exit(info));
    });
}

#[derive(Default)]
struct OutputBuffer {
    inner: Mutex<OutputBufferInner>,
}

#[derive(Default)]
struct OutputBufferInner {
    frames: VecDeque<OutputFrame>,
    total_bytes: usize,
    next_sequence: u64,
}

impl OutputBuffer {
    fn push(&self, data: Vec<u8>) -> OutputFrame {
        let mut inner = self.inner.lock().expect("terminal output buffer poisoned");
        inner.total_bytes = inner.total_bytes.saturating_add(data.len());
        inner.next_sequence = inner.next_sequence.saturating_add(1);
        let frame = OutputFrame {
            sequence: inner.next_sequence,
            data,
        };
        inner.frames.push_back(frame.clone());
        while inner.total_bytes > REPLAY_BYTE_LIMIT {
            let Some(removed) = inner.frames.pop_front() else {
                break;
            };
            inner.total_bytes = inner.total_bytes.saturating_sub(removed.data.len());
        }
        frame
    }

    fn snapshot_after(&self, sequence: u64) -> (Vec<OutputFrame>, u64) {
        let inner = self.inner.lock().expect("terminal output buffer poisoned");
        (
            inner
                .frames
                .iter()
                .filter(|frame| frame.sequence > sequence)
                .cloned()
                .collect(),
            inner
                .frames
                .back()
                .map_or(sequence, |frame| frame.sequence.max(sequence)),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::OutputBuffer;

    #[test]
    fn snapshots_output_after_sequence() {
        let output = OutputBuffer::default();
        let first = output.push(b"one".to_vec());
        let second = output.push(b"two".to_vec());

        assert_eq!(first.sequence, 1);
        assert_eq!(second.sequence, 2);

        let (frames, last_sequence) = output.snapshot_after(1);

        assert_eq!(last_sequence, 2);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].sequence, 2);
        assert_eq!(frames[0].data, b"two");
    }
}
