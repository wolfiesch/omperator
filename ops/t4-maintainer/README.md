# T4 live OMP maintainer

This user service watches official Oh My Pi releases and gives GPT-5.6 Sol ownership of each T4 compatibility update. It runs as the normal host account with the standard OMP toolset, existing `gh` authentication, and `yolo` approval mode. There is no sandbox or reduced tool list.

The timer checks every two hours and targets GitHub's latest stable OMP release. Several releases between checks collapse into one update to the newest version. Before any processed or pending no-op, the deterministic wrapper fast-forwards fork `main` to exact official `main` without Sol. It proves ancestry and temporarily disables the canonical fork CI workflow for that mirror push. The wrapper durably snapshots the pre-existing exact-SHA run IDs before it pushes. After GitHub has observed the event, it re-enables and proves the workflow active, cancels only a new first-attempt `ci.yml` push run whose branch and SHA exactly match the mirrored official `main`, and observes the bounded delivery window plus several active-free polls. Older runs and human rerun attempts remain untouched. Durable phase state covers accepted pushes with lost client responses and makes interrupted enablement or run settlement fail closed. Legacy recovery markers without a run snapshot only restore the workflow and never cancel a run. Official `can1357/oh-my-pi` tags are immutable upstream inputs, while `wolfiesch/oh-my-pi:t4code/main` is the durable T4 product branch. Sol merges the exact base into the product line, resolves the integration, and marks releases with immutable `t4code-<omp-version>-appserver-<revision>` tags. The wrapper-owned publisher sends the exact base tag object, product branch, and annotated integration tag in one atomic three-ref push with durable intent and receipt recovery. `flock` keeps one maintainer active at a time. The dedicated OMP profile is `t4-maintainer`, and its sessions remain available for follow-up.

The profile's `auth-broker.token` is a symlink to the existing mode-0600 broker token file. This keeps one credential source while giving OMP the profile-local path it resolves at launch.

Before calling Sol, the runner retries an existing pending publication, repairs local drift from the last processed receipt, and checks T4 `main`, the matching version tag, and the latest public release. Active or recently successful publication workflows are allowed to converge without a duplicate call. A compatible partial release with no live workflow, or one with terminal failures, is handed back to Sol with its existing commit, version, and tag in the run context.

The live call is `omp --profile t4-maintainer --model openai-codex/gpt-5.6-sol --thinking max --print --mode json --approval-mode yolo`, with the positive maintainer prompt and exact release context appended. Sol owns appserver/app-wire reconciliation, version and provenance changes, release checks, commits, merges, GitHub publication, and the site deployment. The wrapper owns routine fork-main synchronization and provides the only OMP publication helper.

After Sol exits, the runner requires the matching helper-owned atomic receipt and independently resolves every tag and commit. It requires fork `main` to equal official `main`, proves the fork base-tag object and commit exactly equal the official tag, proves integration ancestry and product-branch reachability, and requires successful T4 publication workflows. It also requires the fixed OMP CI workflow's successful push run for the exact integration commit on `t4code/main` and an exact integration release containing only the five expected Linux, macOS, and Windows binaries. Initial verification downloads and SHA-256 checks every OMP binary. Fresh, adopted, and Sol-written results cannot seed the reduced proof: the wrapper removes any incoming proof, creates its own after the full checks, and reuses only that proof across later convergence attempts and timer runs. T4 verification requires an exact seven-asset bundle: five installable packages, `latest-linux.yml`, and `SHA256SUMS.txt`, whose six entries cover the packages and updater metadata. It also fetches `https://t4code.net/releases/latest.json` and matches its schema, version, tag, release URL, canonical five-package set, sizes, immutable URLs, and digests against the stable GitHub release and checksum file. The wrapper then downloads the live `latest-linux.yml`, deb, and AppImage with fixed time and size bounds. It verifies their release API SHA-256 digests, exact byte sizes, metadata filenames, and the actual byte sizes and SHA-512 values recorded inside the updater metadata. That proof is tied to the canonical live asset records and reused only while those records remain unchanged. The Linux-only local deployer then repeats the source proofs and performs the guarded cutover. The standalone gateway service helper remains supported on Linux and macOS.

A publicly verified release is written atomically to `state/pending.json`. The local deployer writes `state/deployment-blocked.json` before stopping a service. It durably disables and stops gateway ingress, asks the running fork OMP for an identity-bound atomic `drain-if-idle` receipt with all activity counters at zero, and only then stops the appserver. The transaction records a durable exposure phase before attempting to start the new appserver. From that attempt onward, every failure either obtains an exact identity-bound zero-work drain before rollback or preserves the new state behind a durable operator block. The desktop package, gateway files, and immutable runtime are verified while the gateway remains disabled; deferred gateway installation cannot re-enable it, and the explicit start action re-enables it only at the final gateway exposure step. A crash or incomplete rollback likewise leaves the marker in place so later timer runs stop for reconciliation.

Once the new appserver, package, helper, gateway files, and loopback health match the receipt, the runner records `state/local-applied.json`. Each cutover carries an immutable deployment identity derived from the T4 commit, integration commit, and installed OMP SHA-256; the config, loopback `/healthz`, receipt, and Tailnet `/healthz` must all return that exact value. Tailnet HTTPS reachability is proved separately. A temporary Tailnet or DNS failure, or a stale Tailnet process returning another deployment identity, keeps the exact pending and local-applied records for the next timer; it does not roll back or redeploy the workstation. `state/processed.json` advances only after that final public HTTPS proof succeeds.

Later runs compare processed state with the installed OMP hash and running executable, appserver identity, dpkg verification, tagged runtime commit, tracked source, gateway script, web tree, `ws` tree, helper status, durable gateway enablement, and loopback health. They also re-resolve public refs, workflows, releases, assets, and site metadata. Local drift requeues the same verified publication without calling Sol; public drift fails closed.

The retained gateway runtime contains the tagged source checkout, built web files, and the canonical `ws` package, not the full pnpm dependency tree. Cleanup keeps the active runtime and the previous runtime named by rollback state. Successful Sol workspaces are removed after processed state is durable; failed workspaces and compact logs remain for diagnosis.

This wrapper is an independent correctness and release gate, not an adversarial security boundary. Sol and the verifier run under the same host account and GitHub authority. A compromised unrestricted process could tamper with either side.

Runtime data lives at `~/.local/share/t4-maintainer`:

- `state/processed.json` — latest fully verified publication
- `state/pending.json` — publicly verified publication awaiting successful local deployment
- `state/local-applied.json` — exact local deployment awaiting Tailnet HTTPS proof
- `state/deployment-blocked.json` — durable transaction marker during cutover or after incomplete rollback
- `state/fork-main-sync.json` — recovery marker retained until fork CI is active and the exact mirrored-main run is terminal
- `state/atomic-publication/` — wrapper-owned OMP preparation records, atomic intents, staging repositories, and receipts
- `runs/<omp-version>-<timestamp>/` — context, Sol session output, workspace, and result
- `deployments/` — slim exact-tag T4 gateway runtimes retained for current service and rollback
- `logs/service.log` and `logs/service.error.log` — persistent service output
- `libexec/` — the installed runner and positive maintainer prompt
- `environment` — mode-0600 references for the existing OMP auth broker URL and token file

Install and enable the user timer:

```bash
./ops/t4-maintainer/install.sh
```

Useful operator commands:

```bash
systemctl --user status t4-omp-maintainer.timer
systemctl --user list-timers t4-omp-maintainer.timer
systemctl --user start t4-omp-maintainer.service
tail -f ~/.local/share/t4-maintainer/logs/service.log
```

`install.sh --check` validates the scripts, live tool availability, timer calendar, and rendered systemd units without installing them. Reinstallation holds the same maintainer lock across the complete helper and unit replacement, then releases it before immediate adoption, so an active timer sees one coherent bundle. Long-lived Sol and local-deploy children receive the lock descriptor closed, so background work cannot strand later timer runs. Installation immediately runs the same public verification and state machine used by later timer events: it adopts and deploys a compatible public release, resumes compatible unfinished publication work through Sol, or starts a new Sol release for the latest official stable OMP version.
