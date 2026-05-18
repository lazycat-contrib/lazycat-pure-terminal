# Pure Terminal

Rust + Restty/Ghostty WebShell provider for LazyCat/LightOS.

## Architecture

Pure Terminal uses two protocol lanes:

- WebSocket data plane: `/ws/terminal` carries terminal bytes, resize events, and process lifecycle notices. Browser terminal input is sent as binary UTF-8 frames; text frames are reserved for JSON control messages such as resize and close.
- Connect control plane: `lazycat.webshell.v1.CapabilityService` manages instances, sessions, plugin descriptors, plugin enablement, and control leases.

The protobuf schema is intentionally generic. It describes capabilities, sessions, plugins, invocations, and control leases. Concrete implementations such as sz/rz, tssh file transfer, or AI shell operation are represented as plugin descriptors and opaque payloads rather than hard-coded protocol fields.

## Built-In Plugins

Two built-in plugin descriptors are registered by default:

- `file-transfer`: reserved adapter for sz/rz and tssh-style uploads/downloads.
- `ai-control`: reserved adapter for future AI-assisted shell delegation and supervision.

Both are protocol placeholders. The backend currently accepts invocations for enabled plugins and returns a `pending-implementation` response. The frontend intentionally hides plugin management until file transfer and AI execution workers are implemented.

## Frontend Interaction

The default screen is terminal-first: tabs and common actions are compact icon controls, while instance selection, themes, fonts, tab orientation, and reserved AI settings live behind the settings entry.

Tabs can be horizontal or vertical. Each tab can also be split into stacked panes with split up/down actions. A split pane is implemented by creating another WebShell session for the same LightOS selector and rendering another Restty terminal instance; the Rust WebSocket data plane remains the owner of PTY bytes.

Themes are applied through Restty's Ghostty theme API and mirrored into local CSS variables for the shell chrome. Built-in terminal fonts are served from the app bundle so the CSP does not depend on CDN font loading. Uploaded fonts are stored under `/lzcapp/var/fonts` in LazyCat; local development can override this with `PURE_TERMINAL_FONT_DIR`.

On mobile, the terminal surface exposes a compact shortcut row for Esc, Tab, modifiers, arrows, Enter, and paste. Restty owns desktop keyboard, paste, and IME input so terminal input is not duplicated by global document handlers.

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

- `package.yml` grants `lightos.manage`. The app is visible in the launcher and can select the first running instance when opened without `?name=`.
- `lzc-build.yml` builds the Rust binary, builds frontend assets, and exports `lightos.webshell`.
- `resources/lightos.webshell/default/webshell-provider.json` declares `root_path: "/"` and `support_home: true`.
- `lzc-manifest.yml` routes `/` to the provider executable and enables multi-instance app metadata.

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
