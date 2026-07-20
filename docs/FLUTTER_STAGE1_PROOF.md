# Flutter Stage 1 Proof Contract

## Scope

Build one real Flutter client in `apps/flutter` that connects directly to the unchanged deterministic `omp-app/1` fixture server. The proof must run from the same Dart code on compact and wide layouts. It is not feature parity or a JavaScript bridge.

## Boundaries

- Keep `packages/fixture-server`, `packages/protocol`, and OMP unchanged.
- Inject the fixture WebSocket URL with `--dart-define=T4_DEVELOPMENT_ENDPOINT=...`; never hard-code a developer port.
- Decode every inbound frame before it reaches state. Reject unknown top-level frame families and malformed required fields while preserving additive fields.
- Keep transcript cursors (`snapshot`, `entry`, `event`) separate from host session-index cursors (`session.delta`). Deduplicate durable transcript entries by entry ID.
- UI consumes typed immutable state and sends typed commands; it does not parse JSON or own reconnect policy.

## Deterministic flow

1. Launch `T4_FIXTURE_SCENARIO=stream-v1 node_modules/.bin/jiti e2e/fixture-process.ts` and parse `T4_FIXTURE_READY` for `wsUrl` and `controlUrl`.
2. Connect to the exact `/fixture` URL and send `hello` for protocol range `omp-app/1`, client identity, the `resume` feature, and saved cursors.
3. Accept the initial ordered `welcome`, `sessions`, and `snapshot` frames.
4. Send `session.attach`; accept its successful response and prepared snapshot/replay.
5. Render the fixture session and transcript. Send `session.prompt` with the current revision.
6. Accept the synchronous `{accepted:true}` response. Advance virtual time with `POST /advance?ms=30`.
7. Project the ordered stream: `agent.start`, `turn.start`, `message.update` (`Hello`), `message.update` (`Hello world`), durable `entry`, `message.settled`, `turn.end`, and `agent.end` (`completed`). Cursors must be contiguous and the visible assistant message must converge to `Hello world` without duplication.
8. Force an unclean close with `POST /disconnect`. Reconnect with the last saved transcript cursor, require `welcome.resumed == true`, then attach from that cursor without duplicating entries. A `gap` must mark state desynchronized until a replacement snapshot arrives.
9. Reply to `ping` with matching `pong` nonce and keep command responses correlated by both request and command IDs.

## UI states

- Compact (`390 x 844`): session list is a separate route/drawer, conversation owns the viewport, and the composer stays above the safe area.
- Wide (`1440 x 900`): persistent session navigation beside the conversation.
- Both: visible disconnected, connecting, synchronizing, ready, streaming, retrying, and failed states; transcript scrolling; session selection; prompt submission; cancel-safe controller disposal; light and dark themes.

## Acceptance

- OMP Dart LSP diagnostics are clean for every touched Dart file.
- `flutter analyze` is clean.
- Dart contract checks consume `packages/client/test/fixtures/protocol/omp-app-v1-corpus.json`; valid inbound cases decode and `invalidInbound` cases fail.
- A focused fixture integration check proves the exact stream and reconnect invariants above.
- Browser-driven Flutter Web smoke passes at `390 x 844` and `1440 x 900`.
- The same proof builds and launches on macOS, iOS Simulator, and Android Emulator before Stage 1 is complete. Windows and Linux build viability must not depend on macOS-only Dart imports.
