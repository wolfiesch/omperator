# T4 Code

T4 Code is a free, open-source (MIT) desktop app for [Oh My Pi](https://github.com/can1357/oh-my-pi) (OMP), made for people who live in OMP all day. OMP runs your coding sessions; T4 Code shows them and lets you steer. The app never owns runtime state. It mirrors what the OMP host reports and sends your actions back as commands. It's a ROYCORP project.

![T4 Code main window](docs/assets/t4-code-main.png)

[**Download v0.1.30**](https://github.com/LycaonLLC/t4-code/releases/tag/v0.1.30) · [**Docs**](https://t4code.net/docs) · [**Get the source**](#build-from-source)

## Requirements

T4 Code needs an OMP build with desktop appserver support. For v0.1.30, use the public integration build below.

T4 Code v0.1.30 was verified with OMP 17.0.5 built from [`09835b92`](https://github.com/lyc-aon/oh-my-pi/commit/09835b929cd028e7e3f800b3e4203e3d1f37931c), tagged [`t4code-17.0.5-appserver-8`](https://github.com/lyc-aon/oh-my-pi/tree/t4code-17.0.5-appserver-8). That public integration is based on the official upstream [`v17.0.5`](https://github.com/can1357/oh-my-pi/tree/v17.0.5) tag at [`9fd6e971`](https://github.com/can1357/oh-my-pi/commit/9fd6e97113f5ed3a847e66d346970efdf8afcad9). It recovers safely from a crashed backend whose old process ID still appears alive, while preserving a responsive owner. It also includes privacy-safe project reveal, fast lazy session indexing, cross-session attention and transcript search, the negotiated browser-preview command surface, redacted Codex transport diagnostics, the versioned Agent View lifecycle contract, session-owned cancellation, lock-aware session observation, complete transcript reconciliation, the cooperative `/continue-in-t4` handoff, and deterministic session ordering. Fork CI verifies the exact upstream base, ancestry, release gates, and published binaries. The official upstream v17.0.5 tag has no `appserver` command, so it cannot host T4 Code. The verified runtime is a normal build from the public `lyc-aon/oh-my-pi` source. T4 Code vendors `@oh-my-pi/app-wire` 0.6.2 from integration commit [`04229b1f`](https://github.com/lyc-aon/oh-my-pi/commit/04229b1f46547ac7c0617e55a993496ec9725f46), source tree `8400a3af618e8af11cccf6b20aadcf3a22baf9a1`.

The current source tree uses the same published `@oh-my-pi/app-wire` 0.6.2 contract. It supplies privacy-safe local project reveal, bounded cross-session transcript search, historical context, and the browser-preview wire contract.

| Platform | Arch                  | Package                                   |
| -------- | --------------------- | ----------------------------------------- |
| Android  | arm64, armv7, x86_64  | `.apk` (**signed**)                       |
| Linux    | x86_64                | `.deb`, AppImage                          |
| macOS    | Apple Silicon (arm64) | `.dmg`, `.zip` (**signed and notarized**) |

No Windows build and no Intel Mac build in v0.1.30. The iOS TestFlight build is coming soon.

## What changed in v0.1.30

- The session rail now matches the Codex desktop organization model: search, activity filters, sort controls, collapsible projects, flat and grouped views, and persistent preferences.
- Project menus can create sessions, open folders in the system file manager, collapse a group, or hide it from the rail. Hidden projects remain recoverable through the filter menu.
- The whole workspace received a visual polish pass, with denser information hierarchy, clearer transcript rows, and empty panes that keep their header and close control visible.
- macOS upgrades retry temporary service-stop failures instead of leaving the bundled backend half-updated.
- A crashed backend can no longer trap launchd in a restart loop when its stale process ID still appears alive.
- OMP app-wire 0.6.2 adds the narrow host command used to reveal only a project path already known to the session catalog.

![An OMP TUI session followed in T4 Code: the transcript fills in read-only under an "Active in another app" banner, /continue-in-t4 runs in the terminal, T4 takes over, and the composer accepts input again.](docs/assets/t4-code-tui-handoff.gif)

<p>
  <img src="docs/assets/t4-code-hosts.png" width="49%" alt="Hosts screen listing local OMP profiles (default, experiments, nightly) with running or stopped state, Start/Stop/Restart controls, a Start with T4 checkbox, and connections to this computer and a paired studio-mac host." />
  <img src="docs/assets/t4-code-usage.png" width="49%" alt="Usage screen for the default OMP profile showing Anthropic and OpenAI account windows with used percentages and reset times, and an xAI API key with no usage data reported." />
</p>
<p>
  <img src="docs/assets/t4-code-thinking-fast.gif" width="49%" alt="A running session with composer menus for model, thinking effort, and fast mode while the current turn keeps streaming." />
  <img src="docs/assets/t4-code-tool-flow.gif" width="49%" alt="Semantic transcript rows in a live turn: an explanation with code, an edit with a diff badge, shell, agent, and browser tool rows, and a test command finishing 18 tests." />
</p>

## Install

### Android

1. On the Android phone, sign in to Tailscale with an account that can reach the T4 Code host.
2. Download [`T4-Code-0.1.30-android.apk`](https://github.com/LycaonLLC/t4-code/releases/download/v0.1.30/T4-Code-0.1.30-android.apk).
3. If Android asks, allow your browser or file manager to install unknown apps, then install the APK.
4. Open T4 Code and enter the host's HTTPS Tailscale address, including its port. The app saves the address; you can add more hosts later and switch between them.

The APK does not contain an appserver or expose one to the public internet. It connects to the separately running Tailnet gateway on your OMP host.

### Linux (Debian/Ubuntu)

```sh
wget https://github.com/LycaonLLC/t4-code/releases/download/v0.1.30/T4-Code-0.1.30-linux-amd64.deb
sudo apt install ./T4-Code-0.1.30-linux-amd64.deb
```

Use `apt install` rather than `dpkg -i` so system dependencies resolve automatically.

### Linux (AppImage)

```sh
wget https://github.com/LycaonLLC/t4-code/releases/download/v0.1.30/T4-Code-0.1.30-linux-x86_64.AppImage
chmod +x T4-Code-0.1.30-linux-x86_64.AppImage
./T4-Code-0.1.30-linux-x86_64.AppImage
```

### macOS (Apple Silicon)

1. Download [`T4-Code-0.1.30-mac-arm64.dmg`](https://github.com/LycaonLLC/t4-code/releases/download/v0.1.30/T4-Code-0.1.30-mac-arm64.dmg) (or [`T4-Code-0.1.30-mac-arm64.zip`](https://github.com/LycaonLLC/t4-code/releases/download/v0.1.30/T4-Code-0.1.30-mac-arm64.zip)).
2. Drag `T4 Code.app` into `/Applications`.
3. Open T4 Code normally. The release workflow verifies the pinned publisher, hardened runtime, secure timestamp, Apple notarization, stapled ticket, and Gatekeeper acceptance before publication.

## What the app does

- **Sessions.** Browse sessions grouped by their working folder, create new ones, and switch between them. Rename, terminate a stuck runtime, archive, restore, or permanently delete a session from its menu. Recently used sessions stay warm, so switching back is instant and nothing is replayed twice.
- **Composer.** Send prompts, use slash commands (`/model`, `/compact`, `/retry`, `/review`, `/terminal`, and more), and change the session's model, thinking level, or fast mode inline.
- **Panes.** Watch subagents (and cancel them), apply reviews, browse and preview files on the host, and attach to live terminals with real keyboard input and resize.
- **Browser preview.** Open session-linked browser previews to inspect page layouts, follow live navigations, and interact with the page via coordinate-mapped clicks and keyboard input. Previews use pluggable authority gates, lease-based concurrency locks, and strict opt-in security boundaries.
- **Settings.** Edit host settings over the wire, with an explicit host selector when several hosts are connected; each host keeps its own drafts. Edits stage locally and only apply when the host confirms; a dropped connection never silently writes anything.
- **Hosts & usage.** Run one local appserver per OMP profile, pair remote machines, and read each connected host's account usage and broker status. Everything shown is redacted host truth.
- **Keyboard.** `Ctrl/Cmd+K` search, `Ctrl/Cmd+B` sidebar, `Ctrl/Cmd+1..9` session switch, `Ctrl/Cmd+,` settings. Every workflow is keyboard-operable.

Some actions depend on what the host supports. When a host can't do something (steer a single agent, discard a review, read a file), the control shows as disabled with the reason instead of pretending.

## Local and paired hosts

**Local.** T4 Code looks for the `omp` executable via `$OMP_EXECUTABLE`, your `PATH`, and common install locations (`~/.local/bin`, `/usr/local/bin`, `/opt/omp/bin`, ...). It then manages one appserver per OMP profile for you: a systemd user service on Linux, a launch agent on macOS. Named profiles under `~/.omp/profiles` appear as their own local hosts and can auto-start with the app. Appserver logs land in `~/.local/state/t4-code/appserver` (Linux) or `~/Library/Logs/T4 Code/appserver` (macOS); named profiles log under `profiles/<id>` inside those directories.

**Paired.** Connect to an OMP host on another machine through a `t4-code://pair/...` link generated on that host. Device credentials are encrypted with your OS keychain (Electron `safeStorage`) before they touch disk. Dropped connections reconnect automatically with backoff, and any settings you had staged stay staged until the host confirms.

**Tailnet browser.** A source checkout can serve the web app to a phone through Tailscale Serve; see [Tailnet remote access](docs/TAILNET_REMOTE.md). There is no T4 app password in this mode. Tailscale identity plus your tailnet ACLs or grants are the access boundary, so keep the route on Serve and never enable Funnel. Anyone allowed to reach the node and port can operate the connected OMP appserver.

## First run

1. Install and start OMP on the machine you want to work on.
2. Launch T4 Code. On the same machine, it finds `omp` and offers to start the appserver. For another machine, open the pairing link from that host.
3. Pick a project, pick or create a session, and start working.

## Build from source

Needs Node `^24.13.1` and pnpm `11.10.0`.

```sh
git clone https://github.com/LycaonLLC/t4-code.git
cd t4-code
pnpm install
pnpm dev              # web + desktop in watch mode
pnpm check            # release contract, provenance, lint, typecheck
pnpm test             # workspace tests
pnpm test:soak        # headless 10k-history and 20-reconnect stress checks
pnpm package:linux    # .deb + AppImage into release/
pnpm package:mac:unsigned  # unsigned macOS build (on a Mac)
pnpm package:mac      # maintainer-only signed and notarized macOS build
```

The soak command needs no phone, Android emulator, or macOS simulator. It checks the shared data
path and phone-sized browser UI, but it does not certify Android Keystore behavior, WebView
background/foreground lifecycle, APK installation, or networking on a physical device. Those remain
native release checks.

## Architecture

```
apps/desktop   Electron main process: window, local omp discovery,
               appserver lifecycle, pairing, credential storage
apps/web       React UI (Vite): sessions, composer, panes, settings
packages/      client, protocol, remote, service-manager, ui
```

The UI talks to an OMP host over typed WebSocket frames (`omp-app/1`, via the vendored `@oh-my-pi/app-wire`). State flows host → app as frames; user actions flow app → host as commands. The app projects what it receives and never fabricates state.

## Security and license

- Report vulnerabilities privately; see [SECURITY.md](SECURITY.md). Never in a public issue.
- Contributions: [CONTRIBUTING.md](CONTRIBUTING.md).
- Third-party provenance: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and [`provenance/`](provenance/).
- License: [MIT](LICENSE).
