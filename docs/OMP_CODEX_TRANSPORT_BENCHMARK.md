# OMP Codex transport benchmark

Date: 2026-07-18

## Decision

T4 Code can benefit from OMP's WebSocket transport for long, tool-heavy Codex sessions. It should
not connect to OpenAI or handle ChatGPT credentials itself. OMP already owns authentication and the
model connection; T4 should ask OMP for redacted transport status and benchmark results through the
existing app-wire boundary.

Keep OMP's `auto` transport policy as the normal default. WebSocket helped materially in the
20-tool workload, but it was slower in the one-tool workload. A user-facing on/off switch is less
useful than accurate diagnostics showing the transport OMP actually used and whether it fell back.

## What was measured

The checked-in harness runs the same read-only OMP workload twice, once with WebSocket forced and
once with SSE forced. SSE, or Server-Sent Events, is the older request/stream-response path. Each
workload makes a fixed number of sequential `printf` tool calls and verifies the exact tool count.
The current harness also verifies each ordered command against the generated marker command. A run
is excluded from a transport summary unless OMP diagnostics confirm that transport was actually
used with no fallback.

The benchmark used:

| Item | Value |
|---|---|
| OMP | 16.4.4 |
| Authentication | Existing `openai-codex` ChatGPT OAuth session |
| Model | `openai-codex/gpt-5.4-mini` |
| Thinking | Low |
| WebSocket control | `PI_CODEX_WEBSOCKET=1` |
| SSE control | `PI_CODEX_WEBSOCKET=0` |
| Run ordering | Alternating WebSocket-first and SSE-first pairs |
| Credential handling | The harness never reads or prints the OAuth token |

OMP's safe Codex diagnostics confirmed the transport actually used for every measured run. There
were no fallbacks. The recorded request-size metric is the JSON size of model input prepared by
OMP; it is not a packet capture or a claim about total network traffic.

## Results

### Tool-heavy workload: 20 sequential tool calls

Three paired runs completed successfully for each transport. Every run made exactly 20 tool calls.

| Metric | WebSocket | SSE | WebSocket change |
|---|---:|---:|---:|
| Mean wall time | 46.38 s | 55.65 s | 16.7% faster |
| Mean provider time | 40.30 s | 49.52 s | 18.6% faster |
| Mean continuation time-to-first-token | 0.98 s | 1.33 s | 26.7% faster |
| Median continuation time-to-first-token | 0.85 s | 1.02 s | 16.2% faster |
| Mean input JSON prepared per run | 78.3 KB | 926.7 KB | 91.6% smaller |
| Full-context requests per run | 2 | 21 | 90.5% fewer |
| Incremental requests per run | 19 | 0 | WebSocket-only |

The paired wall-time improvements were 10.8%, 32.1%, and 7.6%. The sample is deliberately small,
so the average is a useful local signal, not a universal performance promise.

The first response was not faster: mean initial time-to-first-token was 1.52 seconds for WebSocket
and 1.09 seconds for SSE. The gain arrived during later tool continuations, where WebSocket reused
the connection and sent only new items instead of rebuilding the full input each time.

### Short workload: one tool call

Five paired runs completed successfully for each transport.

| Metric | WebSocket | SSE | WebSocket change |
|---|---:|---:|---:|
| Mean wall time | 10.78 s | 9.38 s | 14.9% slower |
| Mean provider time | 4.38 s | 3.63 s | 20.5% slower |
| Mean continuation time-to-first-token | 0.87 s | 1.14 s | 23.8% faster |
| Mean input JSON prepared per run | about 72.8 KB | about 72.3 KB | effectively unchanged |

With no long continuation chain, connection setup and ordinary model variance outweighed the later
continuation improvement. This is why the result supports `auto`, not "always faster."

## How the pieces should connect

```text
ChatGPT OAuth credentials
          |
          v
   OMP provider layer  ---- owns WebSocket/SSE choice and fallback
          |
          | redacted status + benchmark command over app-wire
          v
   T4 Code desktop UI  ---- displays facts; never handles provider credentials
```

T4 currently mirrors OMP state and sends commands over app-wire. Adding direct OpenAI calls or
passing arbitrary provider environment variables through Electron would break that ownership and
make secret handling harder to reason about.

## Recommended implementation

1. Add an OMP-owned diagnostic result containing configured policy (`auto`, `on`, or `off`), actual
   transport (`websocket` or `sse`), fallback count/reason, and bounded timing/request-size totals.
2. Expose a deterministic benchmark command through app-wire. Use an OMP-internal no-op tool rather
   than shell commands so future runs do not depend on the model following a prompt exactly.
3. Add a T4 diagnostics card that starts the benchmark and shows the redacted result. Label it as
   an OMP ChatGPT OAuth measurement, not a public OpenAI API benchmark.
4. Re-run the benchmark against the exact OMP 17.0.0 appserver integration T4 ships with before
   publishing product claims. This study used the locally installed OMP 16.4.4 CLI.
5. Keep the normal transport setting on `auto`. Add a temporary override only as a troubleshooting
   control, if OMP exposes it safely.

## Reproduce

No API key is required when OMP already has a valid ChatGPT OAuth session.

```sh
node scripts/benchmark-omp-codex-transport.mjs \
  --runs 3 \
  --tool-calls 20 \
  --output /tmp/t4-omp-codex-transport.json
```

The output is redacted JSON containing timings, counts, command-validation status,
selected/actual transports, excluded fallback or unverified runs, and safe OMP request diagnostics.
It excludes prompts, tool output, authorization headers, and credentials.

## Proof boundary and references

This measures OMP's installed `openai-codex` implementation using ChatGPT OAuth. It does not prove
that the private ChatGPT backend is identical to the public Responses API, and it does not prove the
same improvement for every model, network, prompt, or tool chain.

The design matches the public Responses WebSocket guidance: send later input with
`previous_response_id`, keep only one response in flight per connection, reconnect when needed, and
expect the largest gains in long tool loops. See OpenAI's [WebSocket mode guide](https://developers.openai.com/api/docs/guides/websocket-mode),
[conversation state guide](https://developers.openai.com/api/docs/guides/conversation-state), and
[latency optimization guide](https://developers.openai.com/api/docs/guides/latency-optimization).
