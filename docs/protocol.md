# Protocol Notes

## Data Plane

`/ws/terminal` is the terminal hot path. It is intentionally not protobuf:

- binary WebSocket frames carry PTY bytes from backend to frontend;
- binary or text frames carry user input from frontend to backend;
- JSON text frames carry resize and close controls;
- backend sends JSON text frames for `ready`, `error`, and `process-exit`.

Accepted client text messages:

```json
{"type":"input","data":"ls\r"}
{"type":"resize","cols":120,"rows":32}
{"type":"close"}
```

Compatibility shorthands are also accepted:

```text
input:<bytes>
resize:<cols>,<rows>
```

## Control Plane

`lazycat.webshell.v1.CapabilityService` owns typed control APIs:

- `ListInstances`
- `GetProvider`
- `CreateSession`
- `CloseSession`
- `ListSessions`
- `ListPlugins`
- `ConfigurePlugin`
- `InvokePlugin`
- `RequestControl`
- `ReleaseControl`

The browser uses Connect over HTTP for these APIs. This avoids forcing terminal byte streams through browser-limited request streaming while keeping platform operations typed.

## Generic Plugin Protocol

Plugins are described with:

- stable `id`;
- generic `kind`;
- `scopes`;
- accepted and produced content types;
- JSON schema strings for input/output payloads;
- enablement state;
- string metadata.

Plugin invocation is opaque:

```protobuf
message InvokePluginRequest {
  string plugin_id = 1;
  string session_id = 2;
  string operation = 3;
  string content_type = 4;
  bytes payload = 5;
  map<string, string> metadata = 6;
}
```

This keeps the protocol stable while future implementations add concrete handlers for file transfer, remote shell adapters, AI control, or human collaboration workflows.
