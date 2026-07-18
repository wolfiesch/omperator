# Performance measurements

T4 uses deterministic fixtures for regression measurements. The VPS lane does the long-running
work; a short native macOS check remains necessary before making claims about Apple Silicon launch,
GPU behavior, or packaging.

## What the commands measure

| Command | Measurement | Intended use |
|---|---|---|
| `pnpm perf:core` | 10k snapshot ingestion, 10k transcript-row derivation, and 100k bounded events | CPU and heap regressions in runtime projections |
| `pnpm perf:ui` | End-to-end mount plus browser-renderer phase timings for the bounded tail of the frozen `history-10k-v1` fixture | Browser UI and paint regression signals |
| `pnpm perf:electron` | Source-build desktop window launch and settled Electron working set | Same-host desktop regression signal |
| `pnpm perf:compare -- <baseline> <current>` | Median change for matching metrics | Fails when a median regresses by more than 10% |

Reports are written to `test-results/perf/`. Each run writes a timestamped JSON file and a
`latest-<kind>.json` copy. The reports include the Git commit, dirty state, Node version, operating
system, CPU model, CPU count, and memory size. They do not record the machine hostname. Set a
non-identifying label such as `T4_PERF_MACHINE_LABEL=hostinger-x64` when several benchmark machines
need to be distinguished. Raw samples are retained; the comparison uses the median and also reports
p95.

The UI report keeps the whole-test duration and also separates the browser work into navigation,
connection after page load, transcript-shell visibility, tail alignment, real-list reveal, and tail
paint. On a cold mount, the timeline commits its warm tail copy first and mounts the hidden virtual
list on the next animation frame, so work that cannot paint does not delay the first useful shell.
It then requires four consecutive ready frames after the list's content geometry and tail alignment
settle before replacing the warm copy. The tail paint sample is taken after the real list replaces
that copy and two more browser animation frames have elapsed. These numbers show where a slowdown
occurs; they are not a claim about a physical display's pixel response time.

`ui.mount-bounded-10k` stops after the original mount assertions, before the paint-only wait and
phase-file write. `ui.playwright-scenario-instrumented` records the full instrumented test duration
under a new name so paint instrumentation cannot silently change an existing comparison boundary.
The mount timer starts with the test body's monotonic `performance.now()` clock. Do not derive it
from Playwright `TestInfo`: reporter results expose a start time, but the in-test object does not.

When source is mirrored without its Git directory, set `T4_PERF_SOURCE_COMMIT` and
`T4_PERF_SOURCE_DIRTY` so the report identifies the local source that was transferred.

The core benchmark runs through the repository's Vite+ test transformer. This is intentional:
the checked-in protocol package publishes TypeScript source, and direct Node type stripping does
not transform TypeScript inside `node_modules`.

Override repetitions with `T4_PERF_REPETITIONS`. Core entry and event counts can be changed with
`T4_PERF_ENTRY_COUNT` and `T4_PERF_EVENT_COUNT`, but comparisons are meaningful only when both runs
use the same scenario values.

## VPS runner

Use a private SSH or Tailscale connection to a Linux VPS. Do not copy `.env` files, OMP profiles,
credentials, browser state, or pairing data. The fixtures require none of them.

The VPS needs an unprivileged user, Node 24, pnpm 11, `xvfb-run`, and the shared libraries required
by Chromium/Electron. From a clean checkout:

```sh
pnpm perf:vps
```

`xvfb-run` supplies an in-memory Linux display so Electron can create a real browser window without
a physical monitor. The runner installs locked JavaScript dependencies and the pinned Playwright
Chromium build, builds the web and desktop code once, and then records all three report families.
It does not open a public port.

The Electron measurement serves the already-built renderer on a temporary loopback-only HTTP port
and launches the source-built Electron main process through its existing development URL boundary.
This keeps the source layout deterministic. It measures a real sandboxed Electron process, but it
does not include installer or packaged-resource startup costs.

The runner also verifies that Electron's downloaded archive was extracted. On hosts where the
package installer finishes downloading but its JavaScript ZIP extractor does not complete, a small
setup helper extracts the same checksum-verified official archive with the host's `unzip` command.
It is a no-op when the Electron binary is already healthy.

Chromium refuses to launch its Linux sandbox when the checkout's `chrome-sandbox` helper lacks root
ownership and mode `4755`. The VPS runner checks that exact dependency file and, when passwordless
sudo is available, applies the ownership and mode Chromium requires. It never passes `--no-sandbox`.

VPS timings are useful for before/after comparisons on the same host. They are not claims about
macOS performance: shared VPS hardware can be noisy, and Xvfb does not reproduce Apple GPU or native
window behavior. Run several repetitions, compare the same fixture and host, and investigate a
repeatable median regression above 10%.

## Short Mac calibration

Before a release or after a major performance change, run `pnpm perf:electron` once on the reference
Mac and record the hardware in the report. Also spot-check scrolling in the 10k fixture. Keep those
numbers separate from the VPS baseline.
