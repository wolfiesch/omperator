# Tailnet remote access

Omperator can be used from a phone or another computer on the same Tailscale
network. The remote path is intentionally small:

```text
phone browser or bundled T4 mobile UI
  -> Tailscale Serve HTTPS/WSS (tailnet only)
  -> T4 gateway on 127.0.0.1:4194
  -> t4-host Unix socket
```

There is no T4 password in this mode. Tailscale membership and your tailnet
ACLs or grants are the access boundary. The gateway never listens on a LAN
interface. It accepts WebSocket connections from the exact configured `.ts.net`
HTTPS origin and the two fixed Capacitor WebView origins described below. No
token or password is passed through the browser or mobile UI.

The Apple Silicon Mac package contains the gateway. Open **Settings → Hosts**,
choose **Set up phone access**, and scan the QR code after setup finishes. T4
Code installs a per-user background service and configures tailnet-only
Tailscale Serve. The source procedure below remains available for Linux and
for maintainers who need a custom gateway layout.

## Prerequisites

- Linux with a systemd user session, or macOS with a logged-in launchd GUI
  session.
- Node.js 24 and pnpm 11 only when using the manual source procedure.
- Tailscale installed, signed in, and using MagicDNS/HTTPS.
- A running local T4 host connected to a compatible OMP bridge. Opening the T4 desktop app normally
  installs and starts it; the retained `omp appserver status --json` administrative command is a
  direct check of the stable service socket.
- A Omperator source checkout with dependencies installed only for manual setup.

Do not use Tailscale Funnel for this. Funnel is the public-internet product;
this setup is meant to remain tailnet-only. Tailscale documents the distinction
and current Serve syntax in its [Serve reference](https://tailscale.com/docs/reference/tailscale-cli/serve).

## Automatic Mac setup

1. Install and sign in to Tailscale on the Mac and phone.
   On iPhone, open the Tailscale profile menu, choose **VPN On Demand**, and
   set both **Wi-Fi** and **Cellular** to **Always** if you want Omperator to
   reconnect without opening Tailscale first. If another VPN uses On Demand,
   iOS allows only one of them to own that behavior at a time.
2. Open Omperator on the Mac and go to **Settings → Hosts**.
3. Choose **Set up phone access**.
4. Scan the displayed QR code with the phone camera.
5. In Safari, optionally choose **Add to Home Screen** for an app icon.

This action is explicit because it changes this Mac's Tailscale Serve
configuration. It binds only the private tailnet HTTPS address to the gateway
on `127.0.0.1:4194`; it does not open a LAN listener or enable Funnel.

## Manual source install

Choose the HTTPS port you will open on your tailnet. The examples use `8445`.
Find this machine's full MagicDNS name with `tailscale status`; it looks like
`host-name.your-tailnet.ts.net`.

From the checkout:

```bash
corepack pnpm install --frozen-lockfile
pnpm build:web

T4_COMMIT=$(git rev-parse HEAD)
OMP_EXECUTABLE=$(command -v omp)
DEPLOYMENT_IDENTITY=$(node -e '
  const crypto = require("node:crypto");
  const fs = require("node:fs");
  const [t4Commit, ompExecutable] = process.argv.slice(1);
  const ompSha = crypto.createHash("sha256")
    .update(fs.readFileSync(fs.realpathSync(ompExecutable))).digest("hex");
  const tuple = Buffer.from(`${t4Commit}\0${ompSha}\0`);
  process.stdout.write(`sha256:${crypto.createHash("sha256").update(tuple).digest("hex")}`);
' "$T4_COMMIT" "$OMP_EXECUTABLE")

node scripts/tailnet-service.mjs install \
  --origin https://host-name.your-tailnet.ts.net:8445 \
  --port 4194 \
  --deployment-identity "$DEPLOYMENT_IDENTITY"

tailscale serve --bg --https=8445 http://127.0.0.1:4194
```

Use the exact URL you will open, including a non-default port, as `--origin`.
The gateway rejects a browser WebSocket whose `Origin` does not match it.
`--deployment-identity` is a non-secret fingerprint of the exact T4 checkout
and OMP executable served by this manual installation. Recompute it whenever
either one changes. The automatic maintainer uses the stricter product identity
derived from the T4 commit, OMP integration commit, and installed OMP SHA-256.

The service installer is idempotent. On Linux it writes and enables
`net.t4code.app.tailnet-gateway.service` as a systemd **user**
unit. On macOS it installs the matching per-user LaunchAgent. It stores no
Tailscale key, OMP token, or app password.

If the T4 host uses a non-default service socket, add an absolute path:

```bash
node scripts/tailnet-service.mjs install \
  --origin https://host-name.your-tailnet.ts.net:8445 \
  --port 4194 \
  --app-socket /absolute/path/to/appserver.sock \
  --deployment-identity "$DEPLOYMENT_IDENTITY"
```

## Verify before relying on it

Run all three host checks:

```bash
node scripts/tailnet-service.mjs status
curl --fail --silent --show-error http://127.0.0.1:4194/healthz
tailscale serve status
```

`status` exits nonzero if the installed definition drifted, the supervisor is
not running and durably enabled, the web build is missing, or the gateway
cannot reach the T4 host socket. A healthy response reports `"web":true` and
`"upstream":true`.

Then, from a different device on the tailnet, open:

```text
https://host-name.your-tailnet.ts.net:8445/
```

The page should show a connected host, list the same sessions as the desktop,
open durable transcript history, and allow a message to be sent. Loading the
page alone is not an end-to-end check; connected state plus a real session
round-trip is.

## Install on a phone

Open the Tailnet URL, then tap the download button in the Omperator titlebar.

- On Android or another Chromium browser, Omperator opens the native install
  prompt when the browser makes it available. If it is not ready yet, the
  button shows where to find **Install app** or **Add to Home screen** in the
  browser menu.
- On iPhone or iPad, tap **Share**, then **Add to Home Screen**. JavaScript
  cannot open that system sheet directly, so the T4 button shows the steps.

The installed web app opens in a standalone window. Its titlebar download
button becomes **Reload Omperator**, which reloads the live gateway UI without
browser chrome.

This is still a thin client, not an offline copy of Omperator. The phone must be
connected to the tailnet, the host gateway must be running, and OMP remains the
owner of every session. The web app deliberately does not cache transcripts,
host configuration, or runtime state for offline use.

## Native mobile client origins

The Android APK and the planned iOS build bundle the T4 UI. They connect to the
same `/v1/ws` endpoint over WSS; they do not load the hosted website into the
WebView. Capacitor's documented defaults give those bundled pages these
origins:

- Android: `https://localhost`
- iOS: `capacitor://localhost`

The service installer writes those exact values to
`T4_NATIVE_ALLOWED_ORIGINS`. The gateway accepts them in addition to the one
Tailnet HTTPS origin passed through `--origin`. Empty values, `null`, wildcard
origins, alternate localhost schemes, and extra origins are rejected at
startup. These values must stay aligned with the mobile
`server.hostname`, `server.androidScheme`, and `server.iosScheme` settings. See
the [Capacitor configuration reference](https://capacitorjs.com/docs/config#schema)
for the platform defaults.

The hosted web response keeps an exact `connect-src` entry for its configured
`wss://HOST.ts.net[:PORT]` endpoint. The bundled mobile document can connect to
user-selected profiles only under `wss://*.ts.net:*`. That subdomain pattern
restricts outbound destinations; it is never added to the gateway's accepted
WebSocket Origin list. Do not replace either policy with an unrestricted
`connect-src *`.

An Origin header identifies the page that opened the WebSocket. It does not
prove that the caller is the signed T4 APK. Tailscale membership and ACLs remain
the access boundary, so the gateway must stay behind Tailscale Serve with
Funnel disabled.

## Named profile routes

The gateway keeps `/v1/ws` as the default route. A deployment may provide a
static `T4_PROFILE_ROUTES` JSON array with bounded ASCII `id` values, exact
absolute `appSocket` paths, and optional validated `serviceUnit` names. A named
profile is reached at `/v1/profiles/<profileId>/ws`; the route table is not
discovered from the filesystem and unknown IDs are rejected before socket or
process work.

Profile starts are disabled unless `T4_ENABLE_PROFILE_STARTS=1`. When enabled,
only an allowlisted route with a service unit may request a fixed supervisor
start; the gateway never accepts shell text and never stops or restarts a
profile. Starts are coalesced and rate-limited while the gateway waits a
bounded time for the existing private socket checks to pass. The T4 host
still performs its normal device authentication after bridging.

## Operate and update

The lifecycle commands are the same on Linux and macOS:

```bash
node scripts/tailnet-service.mjs status
node scripts/tailnet-service.mjs stop
node scripts/tailnet-service.mjs start
node scripts/tailnet-service.mjs restart
```

`stop` durably disables the service as well as stopping it. `start` explicitly
re-enables and starts it. `restart` explicitly re-enables it and replaces the
running process, so updated definitions and configuration take effect on both
Linux and macOS. An intentionally stopped gateway stays stopped across login
or reboot until one of those commands runs.

After pulling a new Omperator revision in the same checkout:

```bash
corepack pnpm install --frozen-lockfile
pnpm build:web
T4_COMMIT=$(git rev-parse HEAD)
OMP_EXECUTABLE=$(command -v omp)
DEPLOYMENT_IDENTITY=$(node -e '
  const crypto = require("node:crypto");
  const fs = require("node:fs");
  const [t4Commit, ompExecutable] = process.argv.slice(1);
  const ompSha = crypto.createHash("sha256")
    .update(fs.readFileSync(fs.realpathSync(ompExecutable))).digest("hex");
  const tuple = Buffer.from(`${t4Commit}\0${ompSha}\0`);
  process.stdout.write(`sha256:${crypto.createHash("sha256").update(tuple).digest("hex")}`);
' "$T4_COMMIT" "$OMP_EXECUTABLE")
node scripts/tailnet-service.mjs install \
  --origin https://host-name.your-tailnet.ts.net:8445 \
  --port 4194 \
  --deployment-identity "$DEPLOYMENT_IDENTITY"
```

If the checkout or Node executable moved, rerun the full `install` command from
the new checkout. The generated service deliberately pins absolute paths so a
different executable cannot be selected through `PATH` after installation.

Linux logs:

```bash
journalctl --user \
  -u net.t4code.app.tailnet-gateway.service \
  -n 100 --no-pager
```

macOS logs are under:

```text
~/Library/Logs/T4 Code/tailnet-gateway/
```

## Uninstall

Remove the T4 service first, then remove only its Tailscale Serve listener:

```bash
node scripts/tailnet-service.mjs uninstall
tailscale serve --https=8445 off
```

The service helper intentionally does not edit Tailscale Serve configuration.
That keeps uninstall from disrupting other sites the node may serve. Avoid
`tailscale serve reset` on a machine with other Serve routes, because reset
removes all of them.

## Security boundary

- The local HTTP gateway is fixed to `127.0.0.1` (or `::1` when explicitly
  configured by code); it cannot be configured to listen on a LAN address.
- The hosted browser endpoint is an exact HTTPS `.ts.net` origin. The native
  exceptions are exactly `https://localhost` and `capacitor://localhost`.
  Plain HTTP Tailnet origins, public domains, URL paths, embedded credentials,
  `null`, wildcard origins, and any other native origin are rejected.
- Tailscale Serve terminates HTTPS and keeps the route tailnet-only. Do not
  substitute Funnel.
- Every tailnet identity permitted to reach this node and port can operate the
  connected T4 host and its OMP sessions. Restrict the node/port with Tailscale ACLs or grants
  if the tailnet has anyone you do not fully trust.
- The gateway is an operator surface, not a read-only viewer. Treat access as
  equivalent to local access to your OMP sessions.
