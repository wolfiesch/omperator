# Runbook: identity rotation

Rotating every credential and identity the chart references. The chart creates
no Secret and no ConfigMap, so every object below is administrator owned and is
rotated outside Helm. Destructive effects: rotating a key invalidates the old
one. Sessions in flight can be disconnected. Nothing durable is deleted.

Never place a credential in a `T4ClusterHost`, `T4Workspace`, `T4Session`, or in
Helm values. Reusable provider credentials never enter the session or controller
workloads.

## 1. Gateway request identity

The gateway has exactly one built-in identity contract, Tailscale, plus
optional referenced adapter configuration.

### Tailscale header identity

Startup requires `T4_CLUSTER_IDENTITY_PROVIDER=tailscale`, a narrow list of
trusted proxy addresses or CIDRs, HTTPS forwarding, and the
`Tailscale-User-Login` header supplied by Tailscale Serve or the Tailscale
Kubernetes operator. Display-name headers are never principals.

Rotation here means changing the trusted transport, not a secret:

1. Add the new proxy address or CIDR to `server.trustedProxyAddresses` or
   `server.trustedProxyCIDRs`.
2. Upgrade ([cluster-upgrade.md](cluster-upgrade.md)).
3. Move traffic to the new transport.
4. Remove the old entry and upgrade again.

Both entries are trusted during the overlap window. Keep it short.

### Referenced OIDC/mTLS adapter configuration

When `server.identity.adapters` is `oidc` and/or `mtls`, the mapping comes from
exactly one referenced ConfigMap **or** Secret; supplying both fails rendering,
and referenced configuration replaces the Tailscale provider rather than
sitting beside it.

```sh
kubectl -n t4-system create configmap cluster-request-identity \
  --from-file=adapters.json=./adapters.json \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n t4-system rollout restart deploy/t4-cluster-server
kubectl -n t4-system rollout status  deploy/t4-cluster-server --timeout=600s
```

Update `networkPolicy.identityProviderCIDRs` first when the provider's discovery
or JWKS endpoints move; an empty list fails closed and the server cannot verify
tokens.

## 2. SSH gateway host key

Rotating the host key changes the fingerprint every client pins. Announce it.

```sh
kubectl -n t4-system create secret generic t4-ssh-host-key \
  --from-file=ssh_host_ed25519_key=./new_host_key \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n t4-system rollout restart deploy/t4-cluster-ssh-gateway
kubectl -n t4-system rollout status  deploy/t4-cluster-ssh-gateway --timeout=600s
```

The Secret name comes from `sshGateway.existingHostKeySecret` and the key from
`sshGateway.hostKeyKey`. The volume is mounted read-only at mode `0400`.

Because `maxUnavailable: 0` with a `minAvailable: 2` PDB and a drain marker at
`/run/sshd/draining` are in force, existing connections drain rather than drop.

## 3. SSH authorized keys, trusted CA, and principals

```sh
kubectl -n t4-system create secret generic t4-ssh-authorized-keys \
  --from-file=authorized_keys=./authorized_keys \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n t4-system create secret generic t4-ssh-trusted-ca \
  --from-file=ca.pub=./ca.pub \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n t4-system create secret generic t4-ssh-principals \
  --from-file=authorized_principals=./authorized_principals \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n t4-system rollout restart deploy/t4-cluster-ssh-gateway
```

`sshGateway.existingTrustedCASecret` and `sshGateway.existingPrincipalsSecret`
are mounted together; configure both or neither. Removing a principal takes
effect on the next pod generation, so restart deliberately after a revocation
rather than waiting for a natural roll.

## 4. Provider assertion keyring

Required when `sshGateway.commands.provider` is enabled. It signs the internal
provider assertion presented to the server's `omp-app/1` upstream
authentication field.

The keyring is a JSON keyring precisely so rotation is overlapping:

1. Add the new key to `keyring.json` alongside the current key and mark the new
   key as the signer.
2. Apply the Secret named by `sshGateway.existingProviderAssertionSecret`.
3. Restart the SSH gateway, then confirm provider commands still succeed.
4. Only after the verifier has observed the new key, remove the retired key and
   apply again.

Never rotate signer and verifier in the same step; that produces a window where
no assertion validates.

## 5. Model provider credential

Only the optional model gateway workload mounts this Secret. Neither the
session, the controller, nor the server ever receives it.

```sh
kubectl -n t4-system create secret generic model-provider \
  --from-literal=credential='Bearer NEW-VALUE' \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n t4-system rollout restart deploy/t4-cluster-model-gateway
kubectl -n t4-system rollout status  deploy/t4-cluster-model-gateway --timeout=600s
```

The Secret value is the complete header value. The gateway strips
caller-supplied authorization, cookie, proxy, forwarding, and hop-by-hop headers
and injects this one allowlisted header, so a stale value fails as an upstream
401 rather than leaking.

Revoke the old credential at the provider only after the rollout is complete.

## 6. Kubernetes-issued identities

These rotate automatically and require no operator action:

- Controller and server API tokens: short-lived projected tokens with the
  `kubernetes.apiAudience` audience.
- The server's internal identity: a separate 10-minute projected token with the
  fixed `t4-cluster-internal` audience.
- The session host's TokenReview credential: an explicit short-lived projected
  token; the session ServiceAccount may only create
  `authentication.k8s.io/tokenreviews`.
- The CI provider token when `woodpecker.serviceAccountAudience` is used:
  projected for `woodpecker.tokenExpirationSeconds`.

Changing `kubernetes.apiAudience` changes all three API-audience projections at
once and requires an upgrade plus a rollout.

## 7. CI provider token

When an existing Secret is used instead of a projected audience:

```sh
kubectl -n t4-system create secret generic t4-ci-token \
  --from-literal=token='NEW-VALUE' \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n t4-system rollout restart deploy/t4-cluster-server
```

Prefer `woodpecker.serviceAccountAudience`: a short-lived projected token has no
rotation runbook at all.

## After any rotation

```sh
kubectl -n t4-system get pods -o wide
kubectl -n t4-system get t4sessions -o \
  jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.status.fenceState}{"\t"}{.status.runtimeGeneration}{"\n"}{end}'
```

No session may be left in `FenceUncertain`; if one is, go to
[cluster-fencing.md](cluster-fencing.md). Record the rotation, the exact object
names, and the time the old credential was revoked.
