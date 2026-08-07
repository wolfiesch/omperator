import { useCallback, useEffect, useState, type ReactNode } from "react";

type Theme = "dawn" | "moon";

/** Screenshot pairs — every surface the Linux client ships. */
const SHOTS: { src: Record<Theme, string>; caption: ReactNode; wide?: boolean }[] = [
  {
    src: { dawn: "screenshots/linux-workspace-dawn.png", moon: "screenshots/linux-workspace-moon.png" },
    caption: (
      <>
        <b>The workspace.</b> Sessions rail, streaming transcript, composer — one host wire, zero Electron.
      </>
    ),
    wide: true,
  },
  {
    src: { dawn: "screenshots/linux-palette-dawn.png", moon: "screenshots/linux-palette-moon.png" },
    caption: (
      <>
        <b>The palette.</b> Every session and action, one keystroke away — ⌕ in the header.
      </>
    ),
  },
  {
    src: { dawn: "screenshots/linux-ask-dawn.png", moon: "screenshots/linux-ask-moon.png" },
    caption: (
      <>
        <b>Plan review.</b> The agent proposes; you decide — nothing runs without your word.
      </>
    ),
  },
  {
    src: { dawn: "screenshots/linux-files-dawn.png", moon: "screenshots/linux-files-moon.png" },
    caption: (
      <>
        <b>Files.</b> The session's workspace, browsed from an in-window sidebar — folders, sizes, breadcrumbs.
      </>
    ),
  },
  {
    src: { dawn: "screenshots/linux-agents-dawn.png", moon: "screenshots/linux-agents-moon.png" },
    caption: (
      <>
        <b>Subagents.</b> Every child of a turn, with progress and lifecycle state.
      </>
    ),
  },
  {
    src: { dawn: "screenshots/linux-browser-dawn.png", moon: "screenshots/linux-browser-moon.png" },
    caption: (
      <>
        <b>A real browser pane.</b> WebKitGTK in a sidebar. This very page lives at{" "}
        <a href="browser-demo/" style={{ color: "var(--gold)" }}>mochi's corner</a>.
      </>
    ),
  },
  {
    src: { dawn: "screenshots/linux-terminal-dawn.png", moon: "screenshots/linux-terminal-moon.png" },
    caption: (
      <>
        <b>Terminal drawer.</b> A real VTE pty docked under the transcript, in VT323.
      </>
    ),
  },
  {
    src: { dawn: "screenshots/linux-plan-dawn.png", moon: "screenshots/linux-plan-moon.png" },
    caption: (
      <>
        <b>Plan strip.</b> The todo board rides along — phases, tasks, done counts.
      </>
    ),
  },
  {
    src: { dawn: "screenshots/linux-inbox-dawn.png", moon: "screenshots/linux-inbox-moon.png" },
    caption: (
      <>
        <b>Inbox.</b> Attention, surfacing: approvals, inputs, and plan reviews across every session.
      </>
    ),
  },
  {
    src: { dawn: "screenshots/linux-search-dawn.png", moon: "screenshots/linux-search-moon.png" },
    caption: (
      <>
        <b>Search &amp; diff.</b> Find files by name, review what changed, before anything runs.
      </>
    ),
  },
  {
    src: { dawn: "screenshots/linux-review-dawn.png", moon: "screenshots/linux-review-moon.png" },
    caption: (
      <>
        <b>Reviews.</b> Findings surface inline with severity — warnings are hard to miss.
      </>
    ),
  },
  {
    src: { dawn: "screenshots/linux-usage-dawn.png", moon: "screenshots/linux-usage-moon.png" },
    caption: (
      <>
        <b>Usage.</b> Context and cost at a glance, straight from the host.
      </>
    ),
  },
  {
    src: { dawn: "screenshots/linux-artifacts-dawn.png", moon: "screenshots/linux-artifacts-moon.png" },
    caption: (
      <>
        <b>Artifacts.</b> The session's produced files, reachable without leaving the rail.
      </>
    ),
  },
];

const VIDEOS: { src: Record<Theme, string>; poster: Record<Theme, string>; caption: ReactNode }[] = [
  {
    src: { dawn: "screenshots/linux-live-dawn.mp4", moon: "screenshots/linux-live-moon.mp4" },
    poster: { dawn: "screenshots/linux-workspace-dawn.png", moon: "screenshots/linux-workspace-moon.png" },
    caption: (
      <>
        <b>Live.</b> Transcript entries paint as they stream — and the tail pins to the bottom while you watch.
      </>
    ),
  },
  {
    src: { dawn: "screenshots/linux-palette-dawn.mp4", moon: "screenshots/linux-palette-moon.mp4" },
    poster: { dawn: "screenshots/linux-palette-dawn.png", moon: "screenshots/linux-palette-moon.png" },
    caption: (
      <>
        <b>The palette, in motion.</b> Open, type, go — themes flip mid-flight.
      </>
    ),
  },
  {
    src: { dawn: "screenshots/linux-browser-dawn.mp4", moon: "screenshots/linux-browser-moon.mp4" },
    poster: { dawn: "screenshots/linux-browser-dawn.png", moon: "screenshots/linux-browser-moon.png" },
    caption: (
      <>
        <b>Browser pane.</b> A genuine little website, loaded inside the app — back, forward, reload, URL field.
      </>
    ),
  },
];

const FEATURES: { glyph: string; color: string; title: string; body: string }[] = [
  {
    glyph: "◍",
    color: "gold",
    title: "Native Swift, real GTK4",
    body: "Not an Electron shell. SwiftCrossUI views over GTK4, a hand-rolled RFC 6455 WebSocket, a VTE terminal, and a WebKitGTK browser pane.",
  },
  {
    glyph: "✳",
    color: "foam",
    title: "Live over the host wire",
    body: "Streaming transcript entries paint as they arrive. Sessions, agents, files, and reviews all flow through one paired connection.",
  },
  {
    glyph: "❦",
    color: "rose",
    title: "Two palettes, one voice",
    body: "Rosé Pine Dawn for the morning, Moon for the night. The gold terminal voice runs through both — even the scrollbars know.",
  },
  {
    glyph: "⌘",
    color: "iris",
    title: "A palette that listens",
    body: "Sessions and actions in one glass card. Connect, switch, rename — without touching the mouse.",
  },
  {
    glyph: "▣",
    color: "pine",
    title: "A terminal that answers",
    body: "A real VTE drawer docked under the transcript, in VT323. Keystrokes go to the host pty; output paints as it lands.",
  },
  {
    glyph: "✓",
    color: "love",
    title: "Approvals, not surprises",
    body: "Dangerous commands surface as ask cards with a plan review. Nothing runs until you say so.",
  },
  {
    glyph: "◫",
    color: "foam",
    title: "Files, read-only and honest",
    body: "Browse the session's workspace with breadcrumbs and sizes — the host stays the single source of truth.",
  },
  {
    glyph: "↻",
    color: "iris",
    title: "Read-only by default, safe always",
    body: "Locks and ownership are the host's job. If another process owns a session, the app watches — it never risks a second writer.",
  },
  {
    glyph: "❯",
    color: "gold",
    title: "Search & diff before runs",
    body: "Search files by name, page through transcript history, and inspect reviews and artifacts from the session detail.",
  },
  {
    glyph: "🔒",
    color: "pine",
    title: "Credentials in libsecret",
    body: "Pairing tokens live in the Secret Service — never in a config file. t4-code:// links prefill the pair sheet.",
  },
  {
    glyph: "✧",
    color: "rose",
    title: "Notifications that mean it",
    body: "Turn endings and pending approvals surface as native notifications — the app pings only when it matters.",
  },
  {
    glyph: "⚡",
    color: "love",
    title: "Fast, on purpose",
    body: "Text measurement is cached, CSS parses once, and one UI pass per main-loop tick — dense sessions stay at 0% idle CPU.",
  },
];

const PALETTE: { name: string; dawn: string; moon: string }[] = [
  { name: "base", dawn: "#FAF4ED", moon: "#232136" },
  { name: "surface", dawn: "#FFFAF3", moon: "#2A273F" },
  { name: "text", dawn: "#575279", moon: "#E0DEF4" },
  { name: "gold", dawn: "#EA9D34", moon: "#F6C177" },
  { name: "foam", dawn: "#56949F", moon: "#9CCFD8" },
  { name: "iris", dawn: "#907AA9", moon: "#C4A7E7" },
  { name: "rose", dawn: "#D7827E", moon: "#EA9A97" },
  { name: "pine", dawn: "#286983", moon: "#3E8FB0" },
  { name: "love", dawn: "#B4637A", moon: "#EB6F92" },
];

const MARQUEE = [
  "ai&",
  "Alibaba Coding Plan",
  "QwenCloud Token Plan",
  "Anthropic (Claude Pro/Max)",
  "Baseten",
  "Cerebras",
  "Cloudflare AI Gateway",
  "CoreWeave Serverless Inference",
  "Cursor (Claude, GPT, etc.)",
  "DeepSeek",
  "Devin",
  "Exa",
  "Fire Pass (Fireworks Kimi K2.6 Turbo subscription)",
  "Fireworks",
  "GitHub Copilot",
  "GitLab Duo Non-Agentic",
  "GitLab Duo Agent",
  "GMI Cloud",
  "Antigravity (Gemini 3, Claude, GPT-OSS)",
  "Google Cloud Code Assist (Gemini CLI)",
  "Hugging Face Inference",
  "Kagi",
  "Kilo Gateway",
  "Kimi Code",
  "LiteLLM",
  "LM Studio (Local OpenAI-compatible)",
  "Meta Model API",
  "MiniMax Token Plan (International)",
  "MiniMax Token Plan (China)",
  "Moonshot (Kimi API)",
  "NanoGPT",
  "Novita",
  "NVIDIA",
  "Ollama (Local OpenAI-compatible)",
  "Ollama Cloud",
  "ChatGPT Plus/Pro (Codex Subscription)",
  "ChatGPT Plus/Pro (Codex, headless/device)",
  "OpenCode Go",
  "OpenCode Zen",
  "OpenRouter",
  "Parallel",
  "Perplexity (Pro/Max)",
  "Qianfan",
  "Qwen Portal",
  "Sakana AI",
  "SiliconFlow",
  "SiliconFlow (China)",
  "Synthetic",
  "Tavily",
  "Together",
  "Umans AI Coding Plan",
  "Venice",
  "Vercel AI Gateway",
  "vLLM (Local OpenAI-compatible)",
  "Wafer Serverless (pay-as-you-go)",
  "xAI API",
  "xAI Grok OAuth (SuperGrok or X Premium+)",
  "Xiaomi MiMo",
  "Xiaomi Token Plan (Europe)",
  "Xiaomi Token Plan (China)",
  "Xiaomi Token Plan (Singapore)",
  "Z.AI (GLM Coding Plan)",
  "Z.AI (GLM Coding Plan · Sign in)",
  "ZenMux",
  "Zhipu Coding Plan (智谱)",
];

function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem("t4-linux-theme") as Theme) || "moon",
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "moon" ? "#232136" : "#faf4ed");
    localStorage.setItem("t4-linux-theme", theme);
  }, [theme]);
  const toggle = useCallback(() => setTheme((t) => (t === "dawn" ? "moon" : "dawn")), []);
  return [theme, toggle];
}

export function LinuxLanding() {
  const [theme, toggle] = useTheme();
  const hero = SHOTS[0]!;
  return (
    <>
      <div className="aurora" aria-hidden="true" />

      <header className="top">
        <span className="wordmark">
          t4<span className="gold">·</span>linux
        </span>
        <nav>
          <a href="/">Omperator</a>
          <a href="docs/">Docs</a>
          <button className="theme-toggle" onClick={toggle} aria-label="toggle theme">
            <span className={`tt-opt ${theme === "dawn" ? "on" : ""}`}>dawn</span>
            <span className={`tt-opt ${theme === "moon" ? "on" : ""}`}>moon</span>
          </button>
        </nav>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <p className="kicker">a native linux client, in swift</p>
          <h1>
            Your agents,
            <br />
            <em>at home</em> on Linux.
          </h1>
          <p className="lede">
            Sessions, subagents, terminals, files, and a whole little browser —
            streaming live over the host wire, dressed in Rosé Pine from rail to
            scrollbar.
          </p>
          <div className="hero-actions">
            <a className="btn gold" href="/">
              Get Omperator
            </a>
            <a className="btn ghost" href="https://github.com/wolfiesch/omperator">
              Source
            </a>
          </div>
        </div>
        <figure className="hero-shot">
          <div className="frame">
            <div className="titlebar">
              <div className="dots">
                <span />
                <span />
                <span />
              </div>
              <div className="url">t4·linux — your agents, at home</div>
            </div>
            <img src={hero.src[theme]} alt="The t4 Linux workspace" />
          </div>
          <span className="badge">flip dawn / moon ☽</span>
        </figure>
      </section>

      <div className="marquee" aria-hidden="true">
        <div className="track">
          {[...MARQUEE, ...MARQUEE].map((item, i) => (
            <span key={i}>
              <span className="g">✦</span> {item}
            </span>
          ))}
        </div>
      </div>

      <section id="gallery">
        <div className="section-head">
          <p className="kicker">every surface</p>
          <h2>One app, all of it.</h2>
          <p>
            Screenshots from the real client — dark and light, live host and
            demo rail. Click nothing, believe everything.
          </p>
        </div>
        <div className="gallery">
          {SHOTS.map((s) => (
            <figure key={String(s.caption)} className={`shot ${s.wide ? "wide" : ""}`}>
              <div className="imgwrap">
                <img src={s.src[theme]} alt={typeof s.caption === "string" ? s.caption : "t4 linux surface"} loading="lazy" />
              </div>
              <figcaption>{s.caption}</figcaption>
            </figure>
          ))}
        </div>
      </section>

      <section id="watch">
        <div className="section-head">
          <p className="kicker">watch it move</p>
          <h2>Not a slide deck.</h2>
          <p>Recorded on the actual client against a real host — streaming, palette, and the little website in the browser pane.</p>
        </div>
        <div className="videos">
          {VIDEOS.map((v) => (
            <figure key={String(v.caption)} className="video-card">
              <video key={theme} src={v.src[theme]} poster={v.poster[theme]} controls preload="none" playsInline />
              <figcaption>{v.caption}</figcaption>
            </figure>
          ))}
        </div>
      </section>

      <section>
        <div className="demo-callout">
          <div>
            <p className="kicker">the browser pane is a real browser</p>
            <h3>That screenshot? A real little website.</h3>
            <p>
              The browser pane is WebKitGTK — back, forward, reload, URL field
              and all. To show it off, we made{" "}
              <a href="browser-demo/" style={{ color: "var(--gold)", fontWeight: 700 }}>
                mochi's corner
              </a>
              : a tiny home on the internet with a CSS cat, a growing list of
              right-nows, and a guestbook that really keeps what you write.
              Open it in the app, or right here.
            </p>
            <a className="btn gold" href="browser-demo/">
              Visit mochi's corner ✦
            </a>
          </div>
          <a className="mini" href="browser-demo/">
            <img src="screenshots/linux-browser-moon.png" alt="mochi's corner inside the browser pane" loading="lazy" />
          </a>
        </div>
      </section>

      <section id="features">
        <div className="section-head">
          <p className="kicker">the whole kit</p>
          <h2>Everything it does.</h2>
        </div>
        <div className="features">
          {FEATURES.map((f) => (
            <article key={f.title} className={`card ${f.color}`}>
              <span className="glyph">{f.glyph}</span>
              <h3>{f.title}</h3>
              <p>{f.body}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="palette">
        <div className="section-head">
          <p className="kicker">the palette</p>
          <h2>One palette, two lights.</h2>
          <p>Rosé Pine Dawn and Moon — the exact tokens the app renders with.</p>
        </div>
        <div className="chips">
          {PALETTE.map((c) => (
            <div key={c.name} className="chip">
              <span className="swatch" style={{ background: theme === "dawn" ? c.dawn : c.moon }} />
              <span className="chip-name">{c.name}</span>
              <span className="chip-hex">{theme === "dawn" ? c.dawn : c.moon}</span>
            </div>
          ))}
        </div>
      </section>

      <footer>
        <p className="status">
          sys.status: <b>online</b> // uptime: continuous // renderer: native
        </p>
        <p>
          <span className="wordmark">
            t4<span className="gold">·</span>linux
          </span>
          <br />
          MIT-licensed. Rosé Pine by <a href="https://rosepinetheme.com">Rosé Pine</a>.
          Type set in VT323 and DM Sans. The cat is pure CSS.
        </p>
      </footer>
    </>
  );
}
