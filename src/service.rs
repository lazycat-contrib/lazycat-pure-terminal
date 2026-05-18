use std::collections::HashMap;
use std::sync::{Arc, RwLockReadGuard, RwLockWriteGuard};

use buffa::MessageField;
use connectrpc::{ConnectError, RequestContext, Response as ConnectResponse, ServiceResult};
use uuid::Uuid;

use crate::config::{APP_ID, APP_NAME, DEFAULT_COLS, DEFAULT_ROWS, MAX_COLS, MAX_ROWS};
use crate::lightos;
use crate::proto::lazycat::webshell::v1::{
    Capability, CapabilityService, CloseSessionResponse, ConfigurePluginResponse, ControlLease,
    CreateSessionResponse, GetProviderResponse, InvokePluginResponse, ListInstancesResponse,
    ListPluginsResponse, ListSessionsResponse, OwnedCloseSessionRequestView,
    OwnedConfigurePluginRequestView, OwnedCreateSessionRequestView, OwnedGetProviderRequestView,
    OwnedInvokePluginRequestView, OwnedListInstancesRequestView, OwnedListPluginsRequestView,
    OwnedListSessionsRequestView, OwnedReleaseControlRequestView, OwnedRequestControlRequestView,
    ProviderDescriptor, ReleaseControlResponse, RequestControlResponse,
};
use crate::state::{
    AppState, PluginRecord, SessionRecord, bool_flag, default_session_command, host_from_selector,
    session_id_for_host,
};
use crate::validation::{normalize_dimension, required_field, validate_selector};

pub struct CapabilityServiceImpl {
    state: Arc<AppState>,
}

impl CapabilityServiceImpl {
    pub fn new(state: Arc<AppState>) -> Self {
        Self { state }
    }

    fn sessions_read(
        &self,
    ) -> Result<RwLockReadGuard<'_, HashMap<String, SessionRecord>>, ConnectError> {
        self.state
            .sessions
            .read()
            .map_err(|_| ConnectError::internal("session store lock poisoned"))
    }

    fn sessions_write(
        &self,
    ) -> Result<RwLockWriteGuard<'_, HashMap<String, SessionRecord>>, ConnectError> {
        self.state
            .sessions
            .write()
            .map_err(|_| ConnectError::internal("session store lock poisoned"))
    }
}

impl CapabilityService for CapabilityServiceImpl {
    async fn list_instances(
        &self,
        _ctx: RequestContext,
        _request: OwnedListInstancesRequestView,
    ) -> ServiceResult<ListInstancesResponse> {
        let instances = lightos::list_instances().await?;
        ConnectResponse::ok(ListInstancesResponse {
            instances,
            ..Default::default()
        })
    }

    async fn get_provider(
        &self,
        _ctx: RequestContext,
        _request: OwnedGetProviderRequestView,
    ) -> ServiceResult<GetProviderResponse> {
        ConnectResponse::ok(GetProviderResponse {
            provider: MessageField::some(provider_descriptor()),
            ..Default::default()
        })
    }

    async fn create_session(
        &self,
        _ctx: RequestContext,
        request: OwnedCreateSessionRequestView,
    ) -> ServiceResult<CreateSessionResponse> {
        let selector = request
            .selector
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| ConnectError::invalid_argument("selector is required"))?;
        validate_selector(selector)?;
        lightos::authorize_selector(selector, true).await?;
        let cols = normalize_dimension(request.cols, DEFAULT_COLS, MAX_COLS, "cols")?;
        let rows = normalize_dimension(request.rows, DEFAULT_ROWS, MAX_ROWS, "rows")?;
        let host = host_from_selector(selector);
        let id = session_id_for_host(&host);
        let (command, args) = default_session_command(selector);
        let mut metadata: HashMap<String, String> = request
            .metadata
            .iter()
            .map(|entry| (entry.0.to_owned(), entry.1.to_owned()))
            .collect();
        let restartable = metadata
            .get("autoRestart")
            .or_else(|| metadata.get("restartable"))
            .and_then(|value| bool_flag(value))
            .unwrap_or(false);
        metadata.insert("host".to_owned(), host.clone());
        metadata.insert("restartable".to_owned(), restartable.to_string());
        let record = SessionRecord {
            id: id.clone(),
            host,
            selector: selector.to_owned(),
            status: "running".to_owned(),
            cols,
            rows,
            command,
            args,
            control: None,
            metadata,
        };
        self.state
            .terminals
            .open(record.terminal_spec(cols, rows), true)
            .map_err(|err| ConnectError::internal(err.to_string()))?;
        let session = record.to_proto();
        let snapshot = {
            let mut sessions = self.sessions_write()?;
            sessions.insert(id, record);
            sessions.clone()
        };
        self.state
            .persist_sessions_snapshot(&snapshot)
            .map_err(|err| ConnectError::internal(err.to_string()))?;
        ConnectResponse::ok(CreateSessionResponse {
            session: MessageField::some(session),
            ..Default::default()
        })
    }

    async fn close_session(
        &self,
        _ctx: RequestContext,
        request: OwnedCloseSessionRequestView,
    ) -> ServiceResult<CloseSessionResponse> {
        let session_id = required_field(request.session_id, "session_id")?;
        self.state.terminals.close(session_id);
        let (status, snapshot) = {
            let mut sessions = self.sessions_write()?;
            let Some(mut record) = sessions.remove(session_id) else {
                return Err(ConnectError::not_found("session not found"));
            };
            "closed".clone_into(&mut record.status);
            (record.status.clone(), sessions.clone())
        };
        self.state
            .persist_sessions_snapshot(&snapshot)
            .map_err(|err| ConnectError::internal(err.to_string()))?;
        ConnectResponse::ok(CloseSessionResponse {
            session_id: Some(session_id.to_owned()),
            status: Some(status),
            ..Default::default()
        })
    }

    async fn list_sessions(
        &self,
        _ctx: RequestContext,
        request: OwnedListSessionsRequestView,
    ) -> ServiceResult<ListSessionsResponse> {
        let selector = request
            .selector
            .map(str::trim)
            .filter(|value| !value.is_empty());
        if let Some(selector) = selector {
            lightos::authorize_selector(selector, false).await?;
        }
        let visible_selectors = if selector.is_none() {
            Some(lightos::authorized_selectors().await?)
        } else {
            None
        };
        let sessions = self.sessions_read()?;
        let sessions = sessions
            .values()
            .filter(|session| selector.is_none_or(|value| session.selector == value))
            .filter(|session| {
                visible_selectors
                    .as_ref()
                    .is_none_or(|selectors| selectors.contains(&session.selector))
            })
            .map(SessionRecord::to_proto)
            .collect();
        ConnectResponse::ok(ListSessionsResponse {
            sessions,
            ..Default::default()
        })
    }

    async fn list_plugins(
        &self,
        _ctx: RequestContext,
        _request: OwnedListPluginsRequestView,
    ) -> ServiceResult<ListPluginsResponse> {
        let plugins = self
            .state
            .plugins
            .read()
            .map_err(|_| ConnectError::internal("plugin store lock poisoned"))?
            .values()
            .map(PluginRecord::to_proto)
            .collect();
        ConnectResponse::ok(ListPluginsResponse {
            plugins,
            ..Default::default()
        })
    }

    async fn configure_plugin(
        &self,
        _ctx: RequestContext,
        request: OwnedConfigurePluginRequestView,
    ) -> ServiceResult<ConfigurePluginResponse> {
        let plugin_id = required_field(request.plugin_id, "plugin_id")?;
        let mut plugins = self
            .state
            .plugins
            .write()
            .map_err(|_| ConnectError::internal("plugin store lock poisoned"))?;
        let Some(plugin) = plugins.get_mut(plugin_id) else {
            return Err(ConnectError::not_found("plugin not found"));
        };
        plugin.enabled = request.enabled.unwrap_or(false);
        for entry in &request.metadata {
            plugin
                .metadata
                .insert(entry.0.to_owned(), entry.1.to_owned());
        }
        ConnectResponse::ok(ConfigurePluginResponse {
            plugin: MessageField::some(plugin.to_proto()),
            ..Default::default()
        })
    }

    async fn invoke_plugin(
        &self,
        _ctx: RequestContext,
        request: OwnedInvokePluginRequestView,
    ) -> ServiceResult<InvokePluginResponse> {
        let plugin_id = required_field(request.plugin_id, "plugin_id")?;
        let plugins = self
            .state
            .plugins
            .read()
            .map_err(|_| ConnectError::internal("plugin store lock poisoned"))?;
        let Some(plugin) = plugins.get(plugin_id) else {
            return Err(ConnectError::not_found(format!(
                "plugin is not registered: {plugin_id}"
            )));
        };
        if !plugin.enabled {
            return Err(ConnectError::failed_precondition(format!(
                "plugin is disabled: {plugin_id}"
            )));
        }
        ConnectResponse::ok(InvokePluginResponse {
            invocation_id: Some(Uuid::new_v4().to_string()),
            status: Some("accepted".to_owned()),
            content_type: Some("application/json".to_owned()),
            payload: Some(
                serde_json::to_vec(&serde_json::json!({
                    "status": "pending-implementation",
                    "pluginId": plugin_id,
                    "operation": request.operation.unwrap_or("default")
                }))
                .map_err(|err| ConnectError::internal(err.to_string()))?,
            ),
            ..Default::default()
        })
    }

    async fn request_control(
        &self,
        _ctx: RequestContext,
        request: OwnedRequestControlRequestView,
    ) -> ServiceResult<RequestControlResponse> {
        let session_id = required_field(request.session_id, "session_id")?;
        let actor_id = request.actor_id.unwrap_or("anonymous").trim();
        let actor_kind = request.actor_kind.unwrap_or("human").trim();
        if actor_id.is_empty() || actor_kind.is_empty() {
            return Err(ConnectError::invalid_argument(
                "actor_id and actor_kind must not be empty",
            ));
        }

        let lease = ControlLease {
            lease_id: Some(Uuid::new_v4().to_string()),
            actor_id: Some(actor_id.to_owned()),
            actor_kind: Some(actor_kind.to_owned()),
            status: Some("active".to_owned()),
            ..Default::default()
        };
        let snapshot = {
            let mut sessions = self.sessions_write()?;
            let Some(session) = sessions.get_mut(session_id) else {
                return Err(ConnectError::not_found("session not found"));
            };
            session.control = Some(lease.clone());
            sessions.clone()
        };
        self.state
            .persist_sessions_snapshot(&snapshot)
            .map_err(|err| ConnectError::internal(err.to_string()))?;
        ConnectResponse::ok(RequestControlResponse {
            lease: MessageField::some(lease),
            ..Default::default()
        })
    }

    async fn release_control(
        &self,
        _ctx: RequestContext,
        request: OwnedReleaseControlRequestView,
    ) -> ServiceResult<ReleaseControlResponse> {
        let session_id = required_field(request.session_id, "session_id")?;
        let lease_id = required_field(request.lease_id, "lease_id")?;
        let snapshot = {
            let mut sessions = self.sessions_write()?;
            let Some(session) = sessions.get_mut(session_id) else {
                return Err(ConnectError::not_found("session not found"));
            };
            let current = session
                .control
                .as_ref()
                .and_then(|lease| lease.lease_id.as_deref());
            if current != Some(lease_id) {
                return Err(ConnectError::failed_precondition(
                    "lease_id does not match active control lease",
                ));
            }
            session.control = None;
            sessions.clone()
        };
        self.state
            .persist_sessions_snapshot(&snapshot)
            .map_err(|err| ConnectError::internal(err.to_string()))?;
        ConnectResponse::ok(ReleaseControlResponse {
            session_id: Some(session_id.to_owned()),
            status: Some("released".to_owned()),
            ..Default::default()
        })
    }
}

fn provider_descriptor() -> ProviderDescriptor {
    ProviderDescriptor {
        id: Some(APP_ID.to_owned()),
        display_name: Some(APP_NAME.to_owned()),
        version: Some(env!("CARGO_PKG_VERSION").to_owned()),
        capabilities: vec![
            Capability {
                id: Some("terminal.session".to_owned()),
                kind: Some("session".to_owned()),
                display_name: Some("Terminal sessions".to_owned()),
                description: Some("Create and control terminal sessions for selected LightOS instances".to_owned()),
                transports: vec!["connect".to_owned(), "websocket".to_owned()],
                schema_json: Some(r#"{"dataPlane":"ws:/ws/terminal","controlPlane":"connect:lazycat.webshell.v1.CapabilityService"}"#.to_owned()),
                ..Default::default()
            },
            Capability {
                id: Some("plugin.invoke".to_owned()),
                kind: Some("plugin".to_owned()),
                display_name: Some("Generic plugin invocation".to_owned()),
                description: Some("Opaque plugin descriptors and payloads for future file transfer, remote shell, AI control, and human operation extensions".to_owned()),
                transports: vec!["connect".to_owned()],
                schema_json: Some(r#"{"pluginId":"string","operation":"string","contentType":"string","payload":"bytes","metadata":"map<string,string>"}"#.to_owned()),
                ..Default::default()
            },
            Capability {
                id: Some("control.lease".to_owned()),
                kind: Some("control".to_owned()),
                display_name: Some("Control leases".to_owned()),
                description: Some("Coordinate human, AI, and system actors without encoding actor-specific behavior in the terminal protocol".to_owned()),
                transports: vec!["connect".to_owned()],
                schema_json: Some(r#"{"actorId":"string","actorKind":"human|ai|system|custom","status":"active|released"}"#.to_owned()),
                ..Default::default()
            },
        ],
        ..Default::default()
    }
}
