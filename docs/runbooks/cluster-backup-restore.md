# Runbook: backup and restore

Quiesced checkpoint of a running session, and restore of workspace plus
runtime-state volumes into a fresh runtime generation.

Destructive effects: restore creates new PVCs and advances to a new generation.
It never reuses the source generation, never rewrites the source snapshots, and
never deletes the source PVCs. Deleting a `VolumeSnapshot` whose class deletion
policy is `Delete` destroys the restore point permanently.

## Two separate domains

| Domain | Volume | Contents |
|---|---|---|
| Workspace | `ReadWriteMany`, `storage.adminRWXStorageClass` | Shared project data under `/workspace` only |
| Runtime authority state | `ReadWriteOncePod` preferred, `storage.runtimeStateStorageClass` | OMP durable state, cmux database/WAL and sockets, browser profile state |

Never place authority paths on RWX storage unless the backend has separately
proved safe shared-WAL and writer-fencing semantics under
`scripts/cluster-ci/storage-conformance.sh`.

## Prerequisites

- `storage.volumeSnapshotClass` is set and its driver matches both
  StorageClasses. Without it, checkpoints, backup, and restore are unavailable.
- `scripts/cluster-ci/storage-conformance.sh --run` has passed for that driver.

## Backup: quiesced checkpoint

### 1. Request the checkpoint

Set a new bounded `spec.checkpoint.id` with `consistency: Quiesced` on the
target `T4Session`. The runtime must drain routes and tickets and persist OMP,
cmux, and browser acknowledgements for the exact current
`status.runtimeGeneration`.

```sh
kubectl -n t4-system get t4session NAME \
  -o jsonpath='{.status.runtimeGeneration}{"\t"}{.status.fenceState}{"\n"}'
```

### 2. Wait for acknowledgement

The controller accepts neither snapshot until every required durable
acknowledgement is present for that generation.

```sh
kubectl -n t4-system get t4session NAME -o jsonpath='{.status.checkpoint}{"\n"}'
```

A session that is already asleep is also valid: no writer remains.

### 3. Confirm both snapshots

The controller creates separate workspace and runtime-state `VolumeSnapshot`
objects labelled `cluster.t4.dev/snapshot-consistency=Quiesced` and the exact
generation.

```sh
kubectl -n t4-system get volumesnapshot \
  -l cluster.t4.dev/snapshot-consistency=Quiesced \
  -o custom-columns=NAME:.metadata.name,READY:.status.readyToUse,SOURCE:.spec.source.persistentVolumeClaimName
```

`CrashConsistent` is an explicit opt-in that skips durable acknowledgements and
is always visibly labelled. Do not describe it as application-consistent, and do
not relabel it.

## Restore

Perform every check. If any is unavailable, stop.

1. **Readiness and provenance.** Both snapshot objects are `ReadyToUse` in the
   target namespace. Verify namespaced PVC sources, a valid source
   runtime-generation label, the expected `cluster.t4.dev/snapshot-source`,
   the consistency label, and StorageClass/snapshot-class driver compatibility.
2. **No live second writer.** List active `T4Session` objects and refuse if the
   runtime-state snapshot is referenced by another runtime that still reports a
   Pod. Desired state or a stale fence status never overrides an active
   attachment. A snapshot never backs two live runtime-state writers.
   ```sh
   kubectl -n t4-system get t4sessions -o \
     jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.podName}{"\t"}{.status.runtimeGeneration}{"\n"}{end}'
   ```
3. **Fence the target.** Drain and positively fence any target writer and
   attachment. `FenceUncertain` stops the restore with no attach, no generation
   advance, no route, and no ticket. See [cluster-fencing.md](cluster-fencing.md).
4. **Create new PVCs from the immutable refs**, record restore provenance, and
   advance through the compare-and-swap replacement machine to a fresh runtime
   generation. Never reuse the source generation.
5. **Preserve the stable public ID by default.** Replacing it requires
   `restorePublicIdPolicy: Replace` plus an explicitly supplied new `publicId`.
   Allocator and tombstone reuse are prohibited.
6. **Prove the restore** before publishing routes: restored workspace data, OMP
   generation provenance, cmux SQLite integrity, and browser durable state.

Keep the source snapshots until that proof and the retention decision are
recorded.

## Prohibited recovery shortcuts

Do not patch status, relabel a crash-consistent snapshot as quiesced,
force-detach storage, delete the source snapshot or PVC to make restore
proceed, or reuse the source generation. Each of these silently converts a
fenced single-writer guarantee into a split-brain risk.

## Retention

Snapshot deletion is destructive and irreversible when the snapshot class
deletion policy is `Delete`. Record the retention decision with the restore
proof, then delete deliberately and by exact name:

```sh
kubectl -n t4-system delete volumesnapshot EXACT-NAME
```

See [cluster-retention-and-destructive-effects.md](cluster-retention-and-destructive-effects.md).
