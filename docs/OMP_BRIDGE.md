# OMP bridge boundary

T4 now owns the generic host service. OMP supplies the small part that must understand OMP's private runtime state.

```text
T4 desktop or mobile
        |
        | omp-app/1
        v
t4-host (T4 executable)
        |
        +-- omp bridge --stdio
        |      sessions, locks, settings, operations, catalog
        |
        `-- omp --mode rpc --session <path>
               one live worker for each active session
```

## T4-owned responsibilities

- WebSocket framing, replay, capability negotiation, pairing, and remote policy
- bounded session projections, attention, transcript search, and artifact reads
- backend-neutral ACP runtime adapters
- Git repository and worktree lifecycle
- deterministic host tests and release gates

## OMP-owned responsibilities

- reading and writing OMP sessions
- lock inspection, takeover, and mutation refusal
- copying a session into a new one through `session.fork`, which only reads the source
- starting, steering, and cancelling OMP agent workers
- OMP settings, model registry, usage, and credentials
- turning OMP-native events into the validated bridge stream

The bridge is a versioned, length-bounded line protocol over standard input and output. It validates every message and fails closed when an operation is unavailable or ownership is unclear. The migrated host temporarily retains a read-only, bounded OMP JSONL projector for transcript search. It may project the exact tested format, but it must not mutate OMP state, infer locks, or invent ownership. A later bridge method can replace that final read-only projector with an OMP-published catalog and event stream.

## Direct replacement rollout

There are no live users to migrate, so this is a replacement rather than a period where two host implementations run side by side.

| Phase                  | What happens                                                                                                                    | Proof before moving on                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Build the bridge       | OMP exposes `omp bridge --stdio`; T4 validates the protocol and owns the network host.                                          | Contract, cancellation, restart, and malformed-message tests pass.            |
| Build the host         | T4 packages the standalone `t4-host` executable and invokes the same OMP binary for the bridge and session workers.             | Compiled T4 and OMP binaries pass a real Unix-socket session smoke test.      |
| Replace the service    | The existing service label is rewritten to launch `t4-host`. A healthy legacy OMP appserver is not accepted as the final owner. | Desktop lifecycle and service-manager tests prove the definition is replaced. |
| Publish together       | Release the small OMP bridge build, pin its tag and hashes in T4, then ship T4 with both executables.                           | Packaging, signing, provenance, full CI, and release inspection pass.         |
| Remove transition code | Delete code that exists only to run or preserve the old OMP-hosted appserver.                                                   | No public `omp appserver serve` or `ompd` launcher remains.                   |

We intentionally skip dual-running hosts, mixed-version client support, live-session transfer, and an in-process runtime rollback system. Rollback remains a Git/release choice: install the previous known-good pair of T4 and OMP artifacts.

The simplified rollout does not weaken the hard boundaries. We retain strict protocol versioning, fail-closed lock behavior, secret redaction, process isolation, restart/reconnect tests, signed host packaging, exact artifact provenance, and protection for existing local development session files.

## Released product state

T4 v0.1.34 is paired with immutable OMP tag `t4code-17.0.5-appserver-16` at commit `675499f428ada2d116088b6a6ceae6586aba137a`. Its published Apple Silicon binary is 120,975,568 bytes with SHA-256 `27b7ab7d725b1ee0d55adce76465e57bd600778ab41a961d06206a54673e8ca5`.

The standalone OMP release carries an ad-hoc integrity signature because the fork release workflow does not have a Developer ID identity. The protected T4 product build remains the distribution-signing boundary: it must sign both the bundled OMP executable and `t4-host` with T4's Developer ID identity before shipping the macOS app.

That bridge release moves the running network host into the standalone T4 executable, removes OMP's public legacy launchers, and lets copied sessions target an existing working directory when the original directory is gone. The thin bridge and standalone host pass a compiled-binary end-to-end smoke test. The compatibility matrix records `appserver-16` as both the verified and published pairing for the T4 product build.

This reduces the fork to the OMP-specific authority adapter and protocol glue, but does not remove the fork entirely. Active runtime tags, releases, and automation are pinned to `wolfiesch/oh-my-pi`. The earlier `lyc-aon/oh-my-pi` repository remains only as frozen provenance for the app-wire package and host-source migration recorded in `provenance/omp-host-migration.json`.
