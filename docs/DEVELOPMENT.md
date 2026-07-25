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

On macOS the sandbox also redirects `HOME`, which leaves no default keychain for Electron
`safeStorage`. The sandboxed app therefore starts with Chromium's mock keychain so credential and
projection-cache encryption stay exercised instead of degrading to unavailable. Sandbox ciphertext
is mock-key material and is not portable to a real login keychain. `pnpm dogfood:mac` launches the
packaged app inside a sandbox too, so it inherits the mock keychain; real keychain behavior is only
exercised by a launch outside any sandbox, with the normal `HOME` and no `T4_DEV_SANDBOX` variables.

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

### Repeatable scenarios and parallel worktrees

Run the deterministic host scenarios without touching personal OMP state:

```sh
pnpm scenario:stream
pnpm scenario:cancel
pnpm scenario:reconnect
pnpm scenario:lifecycle
pnpm scenario:full
```

The runner stages the pinned official OMP runtime, creates disposable profiles and sessions, and
records a redacted report plus wire-event summary under `artifacts/dogfood/`. On Apple Silicon
macOS, `pnpm dogfood:mac` also rebuilds the unsigned application, exercises its bundled host and
runtime, launches the packaged Electron app in an isolated sandbox, and removes that sandbox.

Create parallel work from an exact, freshly fetched `origin/main` commit:

```sh
pnpm worktree create --slug feature-name
pnpm worktree status --slug feature-name
pnpm worktree list
pnpm worktree remove --slug feature-name
```

The helper allocates a `worktree/feature-name` branch, stable non-overlapping development ports,
and project-owned sandbox metadata. It writes the allocated ports to the worktree's ignored
`.artifacts/worktree.env`; `pnpm dev` and `pnpm serve:tailnet` load that file automatically.
Removal refuses dirty worktrees, unloads the sandbox service, and deletes only the named worktree
and branch.

### Remote browser, iPhone/iPad, or Android work

Start with `docs/TAILNET_REMOTE.md`. Browser and iPhone/iPad access use the responsive React/PWA
client; Android uses the React/Capacitor wrapper. Tailscale Serve is the access boundary. Never
enable Funnel or open a public firewall port for development.

## 4. Verify a change

Use `pnpm verify:affected` while iterating to run checks selected from the changed paths, or
`pnpm verify:affected:plan` to preview them without execution. Unknown or cross-cutting paths fail
closed to the full `pnpm check` and `pnpm test` gates. Before opening a pull request, run the
repository gates:

```sh
pnpm check
pnpm test
```

Packaging changes also require `pnpm test:packaging`. A fixture-only pass is not release proof; the
installed-runtime and Tailnet checks remain in `docs/RELEASE_GATE.md`.
