# enclave — omp extension: session sharing + collab control channel

The `/enclave` plugin hosts a collab room (relay + control channel) for an omp
session and registers it with the Tailscale gateway's push registry
(`POST /v1/nodes`, `POST /v1/nodes/<node>/rooms`, 30s heartbeat, 90s TTL), so
the native apps and the web UI can discover and join live sessions.

`enclave.ts` is the single source of truth; `qrcode.ts` is the self-contained
ANSI QR renderer (`/collab qrcode`), vendored alongside. The live install lives
at `~/.omp/plugins/node_modules/enclave/` — this directory is the
version-controlled copy.

## Behavior (1.0.1)

- **Auto-share is ON by default.** Every omp session start (`session_start`)
  opens a room with no marker file and no `/enclave` invocation. Set
  `ENCLAVE_SHARE=0` to opt out. The legacy `~/.omp/enclave-share` marker is
  now ignored.
- **Session switches move the share.** `/resume` and `/new` fire
  `session_switch`, not `session_start`; the plugin tears down the old share
  (closes the relay socket, deregisters the old room) and opens a fresh room
  for the switched-to session. A stale registration used to keep the previous
  session visible — or stream the new session's entries into the old room.
- **Harness sessions can register.** `discoverSessionFileFromFds()` (the
  `/proc/self/fd` fallback for RPC/harness runtimes without `sessionManager`)
  now actually works — `readdirSync`/`readlinkSync` were never imported, so
  harness-spawned sessions silently skipped room registration.

## Deploy

```sh
# sync the version-controlled copy into the live plugin dir
cp scripts/enclave-plugin/{enclave.ts,qrcode.ts,package.json} ~/.omp/plugins/node_modules/enclave/
# bump the version in the omp plugin lock so omp re-reads it
python3 - << 'EOF'
import json, pathlib
lock = pathlib.Path.home() / ".omp/plugins/omp-plugins.lock.json"
d = json.loads(lock.read_text())
d["plugins"]["enclave"]["version"] = "1.0.1"
lock.write_text(json.dumps(d, indent=2) + "\n")
EOF
```

Extensions load when an omp session process starts. Sessions already running
must be restarted once to pick up a new plugin build — after that, autoshare
keeps every future session visible with no manual step.
