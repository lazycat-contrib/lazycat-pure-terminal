# Pure Terminal

Rust + Ghostty WebShell provider for LazyCat/LightOS.

## Architecture

Pure Terminal uses two protocol lanes:

- WebSocket data plane: `/ws/terminal` carries terminal bytes, resize events, and process lifecycle notices.
- Connect control plane: `lazycat.webshell.v1.CapabilityService` manages instances, sessions, plugin descriptors, plugin enablement, and control leases.

The protobuf schema is intentionally generic. It describes capabilities, sessions, plugins, invocations, and control leases. Concrete implementations such as sz/rz, tssh file transfer, or AI shell operation are represented as plugin descriptors and opaque payloads rather than hard-coded protocol fields.

## Built-In Plugins

Two built-in plugin descriptors are registered by default:

- `file-transfer`: reserved adapter for sz/rz and tssh-style uploads/downloads.
- `ai-control`: reserved adapter for future AI-assisted shell delegation and supervision.

Both are configurable through `ConfigurePlugin`; the frontend exposes enable/disable toggles in the plugin panel. The backend currently accepts invocations for enabled plugins and returns a `pending-implementation` response, leaving the execution hooks ready for later plugin workers.

## Development

```bash
npm install
npm run proto:ts
npm run build
cargo test
cargo run
```

For local UI work, run the Rust service on `127.0.0.1:8080`, then:

```bash
npm run dev
```

Open `http://127.0.0.1:5173`. The Vite dev server proxies Connect and WebSocket requests to the Rust backend.

## LPK

Required LazyCat provider pieces are included:

- `package.yml` grants `lightos.manage` and hides the app from the launcher.
- `lzc-build.yml` builds the Rust binary, builds frontend assets, and exports `lightos.webshell`.
- `resources/lightos.webshell/default/webshell-provider.json` declares `root_path: "/"`.
- `lzc-manifest.yml` routes `/` to the provider executable.

Build a release with:

```bash
lzc-cli project release
```

## Runtime Contract

LightOS admin opens:

```text
https://<provider-domain>/?name=<name>@<owner_deploy_id>
```

Selectors must use the exact `<name>@<owner_deploy_id>` shape. Terminal shells run through:

```bash
/lzcinit/lightosctl exec -ti '<selector>' /bin/sh -lc '<bootstrap>'
```

The bootstrap sources `/run/catlink/shell-env.sh` when present, then execs the target instance shell.
