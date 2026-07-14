# T4 Code

T4 Code is a free, open-source (MIT) desktop app for [Oh My Pi](https://github.com/can1357/oh-my-pi) (OMP), made for people who live in OMP all day. OMP runs your coding sessions; T4 Code shows them and lets you steer. The app never owns runtime state. It mirrors what the OMP host reports and sends your actions back as commands. It's a ROYCORP project.

![T4 Code main window](docs/assets/t4-code-main.png)

[**Download v0.1.8**](https://github.com/LycaonLLC/t4-code/releases/tag/v0.1.8) · [**Docs**](https://t4code.net/docs) · [**Get the source**](#build-from-source)

## Requirements

T4 Code needs an OMP build with desktop appserver support. For v0.1.8, use the public integration build below.

T4 Code v0.1.8 was verified with OMP 16.5.0 built from [`d4a0b934`](https://github.com/lyc-aon/oh-my-pi/commit/d4a0b9344e1796c0e56041cfeea3431a8a728e61), tagged [`t4code-16.5.0-appserver-3`](https://github.com/lyc-aon/oh-my-pi/tree/t4code-16.5.0-appserver-3). That public integration is based on the official upstream [`v16.5.0`](https://github.com/can1357/oh-my-pi/tree/v16.5.0) tag at [`3047c27c`](https://github.com/can1357/oh-my-pi/commit/3047c27c332c5629c8e063283d349384c10c9a56). It adds bounded large-session replay, complete desktop runtime events, catalog-backed session management, ordered remote delivery, cross-client control-state convergence, terminal streaming-state settlement, and restart-safe session teardown. The official upstream v16.5.0 tag has no `appserver` command, so it cannot host T4 Code. The verified runtime is a normal build from the public `lyc-aon/oh-my-pi` source; T4 Code does not depend on private home-directory files, an auth broker, or a custom Codex CLI fork. T4 Code vendors `@oh-my-pi/app-wire` 0.5.2 from integration commit [`5d4315ee`](https://github.com/lyc-aon/oh-my-pi/commit/5d4315eea317260fec030e2b4726f10fed0cd5f6), source tree `713688e8099d4553a0a30b1bf415a7cffb5963f4`.

| Platform | Arch | Package |
| --- | --- | --- |
| Linux | x86_64 | `.deb`, AppImage |
| macOS | Apple Silicon (arm64) | `.dmg`, `.zip` (**unsigned, see below**) |

No Windows build and no Intel Mac build in v0.1.8.

## What changed in v0.1.8

- The Tailnet browser client can now be installed to an Android or iPhone home screen. The titlebar download button uses the browser's native install prompt when available and otherwise shows the Add to Home Screen path.
- Installed web apps open in a standalone window with the T4 Code icon. The same titlebar slot becomes a Reload T4 Code button, so a phone user does not need browser chrome to refresh the client.
- Queue and Steer now work during an active turn without sending a stale session revision. Normal prompts keep their revision guard, and negotiated prompt leases remain supported.
- Fast mode now explains what the host actually requests: provider priority processing when supported. It does not imply a lower thinking effort.
- The installed client remains online-only. It fetches the current gateway UI on launch and does not cache host configuration, transcripts, or session state for offline use.
- The arbitrary physical-line ceiling is gone. File boundaries are now judged by cohesion and reviewability instead of a hard line count.
- The manifest, phone icons, gateway content type, install states, active-turn commands, and 320 × 568 titlebar layout are covered by unit and built-app browser tests. The verified OMP 16.5.0 and app-wire 0.5.2 runtime contract is unchanged from v0.1.7.

## Install

### Linux (Debian/Ubuntu)

```sh
wget https://github.com/LycaonLLC/t4-code/releases/download/v0.1.8/T4-Code-0.1.8-linux-amd64.deb
sudo apt install ./T4-Code-0.1.8-linux-amd64.deb
```

Use `apt install` rather than `dpkg -i` so system dependencies resolve automatically.

### Linux (AppImage)

```sh
wget https://github.com/LycaonLLC/t4-code/releases/download/v0.1.8/T4-Code-0.1.8-linux-x86_64.AppImage
chmod +x T4-Code-0.1.8-linux-x86_64.AppImage
./T4-Code-0.1.8-linux-x86_64.AppImage
```

### macOS (Apple Silicon)

> [!WARNING]
> **The macOS v0.1.8 build is unsigned and unnotarized.** Apple has not signed or notarized it, so Gatekeeper can report a "damaged" app or an unidentified developer. Only continue if you trust the release from this repository. You can always build from source instead.

1. Download [`T4-Code-0.1.8-mac-arm64.dmg`](https://github.com/LycaonLLC/t4-code/releases/download/v0.1.8/T4-Code-0.1.8-mac-arm64.dmg) (or [`T4-Code-0.1.8-mac-arm64.zip`](https://github.com/LycaonLLC/t4-code/releases/download/v0.1.8/T4-Code-0.1.8-mac-arm64.zip)).
2. Drag `T4 Code.app` into `/Applications`.
3. If Gatekeeper blocks the app and you choose to proceed, remove the quarantine attributes from the copied app bundle:

   ```sh
   xattr -dr com.apple.quarantine "/Applications/T4 Code.app"
   ```

   This command does not sign, notarize, or verify the app. It only removes the quarantine attribute. If Finder offers **Open** after you right-click the app, that is the no-terminal alternative.

## What the app does

- **Sessions.** Browse sessions grouped by their working folder, create new ones, and switch between them. Rename, archive, restore, or permanently delete a session from its menu. Recently used sessions stay warm, so switching back is instant and nothing is replayed twice.
- **Composer.** Send prompts, use slash commands (`/model`, `/compact`, `/retry`, `/review`, `/terminal`, and more), and change the session's model, thinking level, or fast mode inline.
- **Panes.** Watch subagents (and cancel them), apply reviews, browse and preview files on the host, and attach to live terminals with real keyboard input and resize.
- **Settings.** Edit host settings over the wire. Drafts stage locally and only apply when the host confirms; a dropped connection never silently writes anything.
- **Keyboard.** `Ctrl/Cmd+K` search, `Ctrl/Cmd+B` sidebar, `Ctrl/Cmd+1..9` session switch, `Ctrl/Cmd+,` settings. Every workflow is keyboard-operable.

Some actions depend on what the host supports. When a host can't do something (steer a single agent, discard a review, read a file), the control shows as disabled with the reason instead of pretending.

## Local and paired hosts

**Local.** T4 Code looks for the `omp` executable via `$OMP_EXECUTABLE`, your `PATH`, and common install locations (`~/.local/bin`, `/usr/local/bin`, `/opt/omp/bin`, ...). It then manages the appserver for you: a systemd user service on Linux, a launch agent on macOS. Appserver logs land in `~/.local/state/t4-code/appserver` (Linux) or `~/Library/Logs/T4 Code/appserver` (macOS).

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
pnpm package:linux    # .deb + AppImage into release/
pnpm package:mac:unsigned  # unsigned macOS build (on a Mac)
```

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
