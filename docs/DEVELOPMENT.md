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

### Flutter migration client

Start the deterministic fixture host from the repository root:

```sh
T4_FIXTURE_SCENARIO=stream-v1 node_modules/.bin/jiti e2e/fixture-process.ts
```

Copy the `wsUrl` from `T4_FIXTURE_READY`, then launch a target from another terminal:

```sh
T4_DEVELOPMENT_ENDPOINT=ws://127.0.0.1:PORT/fixture pnpm dev:flutter -- -d macos
```

For the Android emulator, run `adb reverse tcp:PORT tcp:PORT`, then keep
`T4_DEVELOPMENT_ENDPOINT=ws://127.0.0.1:PORT/fixture`. Do not substitute `10.0.2.2`: the
deterministic fixture intentionally binds only to host loopback, so that address leaves the app
retrying with no session selected. Do not expose the fixture through Funnel or a public firewall
rule.

`T4_DEVELOPMENT_ENDPOINT` is only for deterministic fixture work. Without it, the app starts from
its persisted host directory and accepts an exact Tailnet HTTPS address, then performs normal OMP
device pairing. Unsigned macOS `Debug` builds keep the credential in memory only and identify that
behavior in the window; signed Apple configurations and Android use platform secure storage.


Use `pnpm check:flutter` for analysis and `pnpm test:flutter` for the Dart protocol and real-fixture
lifecycle checks. This proof is the migration path under active development; the existing released
clients remain authoritative until the feature and release gates pass.

### Live desktop work

Install the exact verified OMP integration shown by the setup check, then run:

```sh
pnpm dev
```

T4 Code discovers OMP through `OMP_EXECUTABLE`, `PATH`, and its bounded list of common install
locations. The desktop builds and starts `t4-host`, which launches the compatible OMP authority
bridge. Do not point development at a personal production profile when testing destructive session
lifecycle behavior; use a disposable OMP profile and session root.

### Remote browser or Android work

Start with `docs/TAILNET_REMOTE.md`. Tailscale Serve is the access boundary. Never enable Funnel or
open a public firewall port for development.

## 4. Verify a change

Run the focused test for the package you changed while iterating. Before opening a pull request,
run the repository gates:

```sh
pnpm check
pnpm test
```

Packaging changes also require `pnpm test:packaging`. A fixture-only pass is not release proof; the
installed-runtime and Tailnet checks remain in `docs/RELEASE_GATE.md`.
