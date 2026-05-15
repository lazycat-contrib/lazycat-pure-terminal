use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use buffa::MessageField;

use crate::proto::lazycat::webshell::v1::{ControlLease, PluginDescriptor, Session};

#[derive(Clone)]
pub struct AppState {
    pub sessions: Arc<RwLock<HashMap<String, SessionRecord>>>,
    pub plugins: Arc<RwLock<HashMap<String, PluginRecord>>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(RwLock::new(HashMap::new())),
            plugins: Arc::new(RwLock::new(builtin_plugins())),
        }
    }
}

#[derive(Clone, Debug)]
pub struct SessionRecord {
    pub id: String,
    pub selector: String,
    pub status: String,
    pub cols: u16,
    pub rows: u16,
    pub control: Option<ControlLease>,
    pub metadata: HashMap<String, String>,
}

#[derive(Clone, Debug)]
pub struct PluginRecord {
    pub id: String,
    pub kind: String,
    pub display_name: String,
    pub description: String,
    pub scopes: Vec<String>,
    pub accepted_content_types: Vec<String>,
    pub produced_content_types: Vec<String>,
    pub input_schema_json: String,
    pub output_schema_json: String,
    pub enabled: bool,
    pub metadata: HashMap<String, String>,
}

impl SessionRecord {
    pub fn to_proto(&self) -> Session {
        Session {
            id: Some(self.id.clone()),
            selector: Some(self.selector.clone()),
            status: Some(self.status.clone()),
            cols: Some(i32::from(self.cols)),
            rows: Some(i32::from(self.rows)),
            control: self
                .control
                .clone()
                .map_or_else(MessageField::none, MessageField::some),
            metadata: self.metadata.clone(),
            ..Default::default()
        }
    }
}

impl PluginRecord {
    pub fn to_proto(&self) -> PluginDescriptor {
        PluginDescriptor {
            id: Some(self.id.clone()),
            kind: Some(self.kind.clone()),
            display_name: Some(self.display_name.clone()),
            description: Some(self.description.clone()),
            scopes: self.scopes.clone(),
            accepted_content_types: self.accepted_content_types.clone(),
            produced_content_types: self.produced_content_types.clone(),
            input_schema_json: Some(self.input_schema_json.clone()),
            output_schema_json: Some(self.output_schema_json.clone()),
            enabled: Some(self.enabled),
            metadata: self.metadata.clone(),
            ..Default::default()
        }
    }
}

pub fn mark_session_status(state: &AppState, session_id: &str, status: &str) {
    let Ok(mut sessions) = state.sessions.write() else {
        return;
    };
    if let Some(session) = sessions.get_mut(session_id) {
        status.clone_into(&mut session.status);
    }
}

fn builtin_plugins() -> HashMap<String, PluginRecord> {
    [
        PluginRecord {
            id: "file-transfer".to_owned(),
            kind: "transfer".to_owned(),
            display_name: "File Transfer Adapter".to_owned(),
            description: "Generic adapter placeholder for sz/rz and tssh-style uploads and downloads.".to_owned(),
            scopes: vec!["session".to_owned(), "filesystem".to_owned()],
            accepted_content_types: vec![
                "application/json".to_owned(),
                "application/octet-stream".to_owned(),
            ],
            produced_content_types: vec![
                "application/json".to_owned(),
                "application/octet-stream".to_owned(),
            ],
            input_schema_json: r#"{"operation":"upload|download|attach","path":"string","transport":"sz-rz|tssh|custom","payload":"bytes"}"#.to_owned(),
            output_schema_json: r#"{"jobId":"string","status":"queued|running|complete|failed","message":"string"}"#.to_owned(),
            enabled: true,
            metadata: HashMap::from([
                ("builtin".to_owned(), "true".to_owned()),
                ("stage".to_owned(), "reserved".to_owned()),
            ]),
        },
        PluginRecord {
            id: "ai-control".to_owned(),
            kind: "control".to_owned(),
            display_name: "AI Shell Control".to_owned(),
            description: "Generic control plugin placeholder for future AI-assisted shell delegation and supervision.".to_owned(),
            scopes: vec!["session".to_owned(), "control".to_owned()],
            accepted_content_types: vec!["application/json".to_owned()],
            produced_content_types: vec!["application/json".to_owned()],
            input_schema_json: r#"{"mode":"observe|suggest|operate","leaseId":"string","prompt":"string"}"#.to_owned(),
            output_schema_json: r#"{"invocationId":"string","status":"accepted|running|complete|failed"}"#.to_owned(),
            enabled: false,
            metadata: HashMap::from([
                ("builtin".to_owned(), "true".to_owned()),
                ("stage".to_owned(), "reserved".to_owned()),
            ]),
        },
    ]
    .into_iter()
    .map(|plugin| (plugin.id.clone(), plugin))
    .collect()
}
