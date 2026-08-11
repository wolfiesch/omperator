# Runbook: fencing

Diagnosing and clearing runtime writer fencing. Fencing is what guarantees that
exactly one runtime generation writes the runtime-state volume. Destructive
effects: none of the steps here delete durable state. Clearing a fence
correctly always produces a *new* generation; it never revives an old one.

## The state machine

`T4Session.status.fenceState` is one of:

| State | Meaning |
|---|---|
| `NoPriorWriter` | No older generation ever attached. A first start is allowed |
| `DrainRequired` | An older generation is being drained; routes and ticket minting are disabled |
| `ShutdownRequested` | Drain completed; the prior workload is being stopped |
| `FenceVerifying` | The controller is proving the prior workload, writer lease, and runtime-state attachment are authoritatively absent |
| `FenceProven` | Positive proof obtained. A fresh generation may be committed |
| `FenceUncertain` | Proof could not be obtained. Fail closed |

Supporting fields: `status.fencingGeneration`, `status.fencingPodUID`,
`status.fencingVolumeIdentity`, `status.runtimeGeneration`, and the
`Fenced`, `StorageReady`, `RouteReady`, `TicketsRevoked`, and
`GenerationAuthRevoked` conditions.

## Invariants

- A fresh generation is committed only from `FenceProven`, and only with a new
  generation identifier. The source generation is never reused.
- `FenceUncertain` publishes `Fenced=False` with reason `FenceUncertain`, sets
  the phase to `InfrastructureDegraded`, and blocks attach, generation advance,
  route publication, and ticket minting.
- Desired state and a stale fence status never override an active attachment.
- The stable public ID is preserved across generation replacement.

## Triage

### 1. Read the exact state

```sh
kubectl config current-context
kubectl -n t4-system get t4sessions -o \
  jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.phase}{"\t"}{.status.fenceState}{"\t"}{.status.runtimeGeneration}{"\t"}{.status.fencingGeneration}{"\t"}{.status.podName}{"\n"}{end}'
kubectl -n t4-system get t4session NAME -o jsonpath='{.status.conditions}{"\n"}'
```

### 2. Identify why proof failed

```sh
kubectl -n t4-system get t4session NAME \
  -o jsonpath='{range .status.conditions[?(@.type=="Fenced")]}{.reason}{"\t"}{.message}{"\n"}{end}'
kubectl -n t4-system get events --field-selector involvedObject.name=NAME \
  --sort-by=.lastTimestamp
```

Common reasons and the correct response:

| Reason | Cause | Correct response |
|---|---|---|
| Prior Pod still present or `Unknown` on a lost node | The node is partitioned; the kubelet cannot confirm termination | Wait for the node to return or be removed from the cluster by the node lifecycle controller. Do not force-delete the Pod |
| Runtime-state PVC still attached to another node | The CSI driver has not completed detach | Wait for the CSI detach. Do not edit `volumeattachments` |
| `GenerationAuthOwnershipConflict` | The deterministic generation-auth Secret has an unexpected owner | Stop. Investigate who created it. This indicates a second writer or a manual edit |
| Foreign owner on an owned object | A Pod, Service, PVC, or Secret with the expected name is owned by something else | Stop. Do not delete the foreign object to make reconciliation proceed |
| Snapshot referenced by a live runtime | A restore targeted a snapshot that still backs an attached writer | Choose a different restore target or fence the live runtime first |

### 3. Never do these

- `kubectl delete pod --force --grace-period=0` on a session Pod. Force deletion
  removes the API object while the container may still be writing the
  runtime-state volume. This is exactly the split-brain the fence prevents.
- Editing `status.fenceState`, `status.runtimeGeneration`,
  `status.fencingPodUID`, or `status.fencingVolumeIdentity`.
- Deleting or editing `VolumeAttachment` objects.
- Deleting the generation-auth Secret to "unblock" a start.
- Reusing the source generation identifier.

Each of these converts a proven single-writer guarantee into an unproven one,
and the controller cannot detect the difference afterwards.

## Clearing a legitimate `FenceUncertain`

`FenceUncertain` clears on its own once the environment supplies the missing
proof. The supported interventions are environmental, not surgical:

1. Restore the partitioned node, or let the cluster remove it so the kubelet's
   Pods are authoritatively gone.
2. Let the CSI driver complete detach of the runtime-state volume.
3. Resolve the ownership conflict at its source: remove whatever process is
   creating conflicting objects.

The controller then re-enters `FenceVerifying`, obtains positive proof, commits
one fresh generation, and republishes the route. Confirm:

```sh
kubectl -n t4-system get t4session NAME -o \
  jsonpath='{.status.fenceState}{"\t"}{.status.runtimeGeneration}{"\t"}{.spec.publicId}{"\n"}'
```

`fenceState` is `FenceProven`, `runtimeGeneration` is new, and `publicId` is
unchanged.

## Deliberate drain

To stop a runtime cleanly rather than recover one, set the session's desired
state to sleeping and let the ordered `DrainRequired` → `ShutdownRequested` →
`FenceVerifying` → `FenceProven` sequence run. Routes and ticket minting are
disabled before revocation, so no client is left holding a usable ticket for a
generation that is going away.

## Relationship to other runbooks

- Restore requires a positively fenced target:
  [cluster-backup-restore.md](cluster-backup-restore.md).
- A workload rollback must not leave any session in `FenceUncertain`:
  [cluster-rollback.md](cluster-rollback.md).
- Uninstall waits for session Pods and Services to disappear:
  [cluster-uninstall.md](cluster-uninstall.md).
