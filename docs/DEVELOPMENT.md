# Development setup

This guide separates two useful development paths:

- **UI and interaction work** can run against deterministic sample data. It does not need OMP.
- **Live desktop and remote work** needs the verified OMP integration listed in
  `compat/omp-app-matrix.json`. An ordinary upstream OMP release without the authority bridge cannot
  supply T4 Code's standalone host.

## 1. Prepare the source toolchain

T4 Code requires Node `^24.13.1` and pnpm `11.10.0`. Check the active versions before installing:

```sh
node --version
pnpm --version
pnpm install --frozen-lockfile
```

If you use [Task](https://taskfile.dev/) as a Make alternative, install it first (`brew install
go-task` on macOS), then use the repository shortcuts:

```sh
task setup
task doctor
task dev:web
task verify
```

Run `task` to see every available shortcut and a short explanation. These commands wrap the same
`pnpm` scripts documented below; Task is optional and does not replace the pinned Node or pnpm
versions.

If Node reports a different major version, select a compatible Node 24 release with your normal
version manager and reinstall dependencies. Do not ignore the engine warning: using another Node
major can change Electron, WebSocket, and test behavior.

## 2. Run the setup check

After dependencies are installed, run:

```sh
node scripts/t4-doctor.mjs
```

The command is read-only. It uses the same bounded OMP discovery and status probe as the desktop
app, counts profiles without printing their names, and never prints executable paths, home paths,
hostnames, IP addresses, credentials, or raw command failures.

It checks:

| Check                               | Required for                                |
| ----------------------------------- | ------------------------------------------- |
| Supported platform and architecture | Packaged desktop parity                     |
| Node and pnpm versions              | All source development                      |
| Compatible OMP authority bridge     | Live desktop sessions                       |
| Default T4 host health              | Immediate local connection                  |
| Native OMP profile discovery        | Multiple local profiles                     |
| Tailscale status                    | Android, browser, and paired computers only |

`FAIL` means live development is not ready. `WARN` identifies an optional or currently stopped
component; for example, Tailscale is not required for local desktop work. The process exits with
status 1 only when a required check fails.

For a machine-readable report that is safe to attach to a public bug report:

```sh
node scripts/t4-doctor.mjs --json
```

Still review any attachment yourself before publishing it. Do not attach host logs without
following the redaction rules in `CONTRIBUTING.md`.

## 3. Choose a development path

### UI-only work with sample data

```sh
pnpm dev:web
```

The browser build uses deterministic sample sessions and labels them **Sample data**. This is the
fastest path for layout, interaction, accessibility, and renderer work. It does not prove that a
real OMP host can connect or execute a command.

### Live desktop work

For routine Omperator development, use the pinned runtime and an explicitly named disposable
sandbox:

```sh
pnpm dev:live:pinned -- --sandbox feature-name
```

This stages the OMP version recorded in `compat/omp-app-matrix.json`, runs the setup check, and
isolates OMP configuration, sessions, host state, Electron user data, temporary files, and logs
under `.artifacts/dev/feature-name/`. Electron main/preload and host changes rebuild and restart
their affected processes without restarting the renderer. Process output and lifecycle events are
also recorded as credential-redacted NDJSON under the sandbox's `logs/processes/` directory. These
local logs can still contain project and home paths; review and sanitize them before sharing.

Use the compatible OMP already on `PATH` only when testing that explicit mode:

```sh
pnpm dev:live:system -- --sandbox system-runtime
```

Inspect or remove a sandbox by name:

```sh
pnpm dev:sandbox status --sandbox feature-name
pnpm dev:sandbox reset --sandbox feature-name
```

`pnpm dev` remains the lower-level non-isolated development loop. Do not use it with a personal
profile when testing destructive session lifecycle behavior.

### Remote browser, iPhone/iPad, or Android work

Start with `docs/TAILNET_REMOTE.md`. Browser and iPhone/iPad access use the responsive React/PWA
client; Android uses the React/Capacitor wrapper. Tailscale Serve is the access boundary. Never
enable Funnel or open a public firewall port for development.

## 4. Verify a change

Run the focused test for the package you changed while iterating. Before opening a pull request,
run the repository gates:

```sh
pnpm check
pnpm test
```

Packaging changes also require `pnpm test:packaging`. A fixture-only pass is not release proof; the
installed-runtime and Tailnet checks remain in `docs/RELEASE_GATE.md`.
