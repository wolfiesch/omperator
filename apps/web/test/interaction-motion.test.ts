// Interaction choreography contract. Every toggle/disclosure/drawer/tab
// surface either carries a token-bound state transition or is a documented
// deliberate instant state. This test pins both sides so a new disclosure
// can't silently ship as a hard pop again.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeCommandResult, decodeHello } from "@t4-code/protocol";
import { describe, expect, it } from "vite-plus/test";

const SRC = join(import.meta.dirname, "../src");
const rows = readFileSync(join(SRC, "features/transcript/TranscriptRows.tsx"), "utf8");
const appCss = readFileSync(join(SRC, "app.css"), "utf8");
const drawer = readFileSync(join(SRC, "features/terminal/TerminalDrawer.tsx"), "utf8");
const resize = readFileSync(join(SRC, "components/ResizeHandle.tsx"), "utf8");
const theme = readFileSync(join(SRC, "theme/theme.ts"), "utf8");

describe("transcript disclosures animate", () => {
  it("every conditional disclosure body lives inside AnimatedHeight", () => {
    const bodies = [...rows.matchAll(/\{open && \(/g)];
    expect(bodies.length).toBe(3);
    for (const match of bodies) {
      const before = rows.slice(Math.max(0, (match.index ?? 0) - 60), match.index);
      expect(before, `disclosure body at ${match.index} missing AnimatedHeight`).toContain(
        "<AnimatedHeight>",
      );
    }
  });

  it("each disclosure body fades in via the shared enter animation", () => {
    // Reasoning, tools, unknown entries, and collaboration message bodies.
    expect([...rows.matchAll(/disclosure-content-enter/g)].length).toBe(4);
  });

  it("disclosure chevrons rotate on a motion token", () => {
    const chevrons = [...rows.matchAll(/transition-transform duration-\(--motion-duration-fast\)/g)];
    expect(chevrons.length).toBeGreaterThanOrEqual(3);
  });
});

describe("choreographed enter/exit surfaces are token-bound", () => {
  for (const name of [
    "pane-content-enter",
    "disclosure-content-enter",
    "drawer-enter",
    "drawer-exit",
    "theme-icon-enter",
  ]) {
    it(`${name} keyframe animation exists and uses motion tokens`, () => {
      expect(appCss).toContain(`@keyframes ${name}`);
      const rule = appCss.match(new RegExp(`\\.${name} \\{[^}]+\\}`))?.[0] ?? "";
      expect(rule).toContain("var(--motion-duration-");
      expect(rule).toContain("var(--motion-ease-");
    });
  }

  it("the docked pane tween is token-bound width+opacity", () => {
    const rule = appCss.match(/\.pane-dock \{[^}]+\}/)?.[0] ?? "";
    expect(rule).toContain("width var(--motion-duration-deliberate)");
    expect(rule).toContain("opacity var(--motion-duration-deliberate)");
  });

  it("the rail collapse/expand tween is token-bound width and rail content is instant", () => {
    const rule = appCss.match(/\.rail-dock \{[^}]+\}/)?.[0] ?? "";
    expect(rule).toContain("width var(--motion-duration-base)");
    const shell = readFileSync(join(SRC, "components/AppShell.tsx"), "utf8");
    expect(shell).toContain("rail-dock");
    expect(shell).not.toContain("rail-content-enter");
    expect(appCss).not.toContain("rail-content-enter");
  });

  it("terminal drawer close plays a transform-only exit then unmounts once", () => {
    // Exit is opacity/translate (the PTY box never resizes mid-animation);
    // unmount happens on animation end, immediately under reduced motion.
    expect(drawer).toContain("drawer-exit");
    expect(drawer).toContain("onAnimationEnd");
    expect(drawer).toContain("reducedMotion");
    const exit = appCss.match(/@keyframes drawer-exit \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(exit).not.toContain("height");
  });

  it("the theme toggle acknowledges the click on the control itself", () => {
    const titlebar = readFileSync(join(SRC, "components/Titlebar.tsx"), "utf8");
    expect(titlebar).toContain("theme-icon-enter");
  });
});

describe("deliberate instant states stay deliberate", () => {
  it("panel drags and theme surface flips suppress transitions", () => {
    expect(resize).toContain('classList.add("no-transitions")');
    expect(theme).toContain('classList.add("no-transitions")');
  });
});

describe("transcript follow coalesces layout writes", () => {
  const timeline = readFileSync(
    join(SRC, "features/transcript/TranscriptTimeline.tsx"),
    "utf8",
  );

  it("pins the React commit in layout and coalesces resize feedback onto one frame", () => {
    expect(timeline).toContain("useLayoutEffect");
    expect(timeline).toContain("new ResizeObserver(schedulePinToEnd)");
    expect(timeline).toContain("requestAnimationFrame(() =>");
    // No timeout-driven scrolling anywhere in the follow path.
    expect(timeline).not.toMatch(/setTimeout\([^)]*scroll/i);
  });

  it("gates the pin on synchronous refs so a same-frame user scroll wins", () => {
    expect(timeline).toContain("atEndRef.current");
    expect(timeline).toContain("disclosureActiveRef.current");
  });
});

describe("session refresh renders without flicker", () => {
  const screen = readFileSync(join(SRC, "components/SessionScreen.tsx"), "utf8");
  const timeline = readFileSync(
    join(SRC, "features/transcript/TranscriptTimeline.tsx"),
    "utf8",
  );
  const indexHtml = readFileSync(join(SRC, "../index.html"), "utf8");
  const bootstrap = readFileSync(join(SRC, "../public/t4-bootstrap.js"), "utf8");

  it("the session root carries no entrance animation class, ever", () => {
    // Superseded contract: session content hard-switches fully opaque at
    // final coordinates on cold load AND in-app A→B switches. No
    // session-enter class, no gate, no conditional animation on the root.
    expect(screen).not.toContain("session-enter");
    expect(screen).not.toContain("sessionShownThisLoad");
    expect(appCss).not.toContain("session-enter");
  });

  it("cold list mounts are masked by a warm overlay removed on layout, not a timer", () => {
    expect(timeline).toContain("coldMount");
    expect(timeline).toMatch(/\{listMounted && \(\s*<LegendList/);
    expect(timeline).toContain("requestAnimationFrame(() => setListMounted(true))");
    expect(timeline).toContain("[following, listMounted, rows, bottomInset, pinToEnd]");
    expect(timeline).toContain("[following, listMounted, locateScroller, pinToEnd]");
    expect(timeline).toContain("legend-list-content-container");
    expect(timeline).toContain("REVEAL_STABILITY_FRAMES = 4");
    expect(timeline).not.toMatch(/setTimeout\([^)]*coldMount/i);
  });

  it("cross-document navigation keeps a discrete hold under reduced motion", () => {
    expect(appCss).toContain("@view-transition");
    expect(appCss).toMatch(/navigation:\s*auto/);
    expect(appCss).toMatch(/::view-transition-old\(root\)[\s\S]*steps\(1,\s*end\)/);
    expect(appCss).not.toContain("prefers-reduced-motion");
  });

  it("cross-document navigation holds old root discretely then cuts to an opaque new root", () => {
    expect(appCss).toMatch(/navigation:\s*auto/);
    expect(appCss).toContain("::view-transition-group(root)");
    expect(appCss).toContain("::view-transition-old(root)");
    expect(appCss).toContain("::view-transition-new(root)");
    expect(appCss).toContain("@keyframes root-old-hold");
    expect(appCss).toMatch(/::view-transition-old\(root\)[\s\S]*steps\(1,\s*end\)/);
    expect(appCss).toMatch(/::view-transition-new\(root\)[\s\S]*animation:\s*none/);
    expect(appCss).not.toMatch(/::view-transition-group\(root\)[\s\S]*animation-duration:\s*0s/);
    expect(appCss).not.toContain("crossfade");
  });

  it("local control micro-interactions stay animated", () => {
    // Removing the session entrance must not take the local choreography
    // with it — drawers/panes/disclosures keep their token-bound motion.
    expect(appCss).toContain("@keyframes drawer-enter");
    expect(appCss).toContain("@keyframes disclosure-content-enter");
  });

  it("index.html loads the external theme bootstrap before the module bundle", () => {
    const bootstrapIndex = indexHtml.indexOf('src="./t4-bootstrap.js"');
    const moduleIndex = indexHtml.indexOf('type="module"');
    expect(bootstrapIndex).toBeGreaterThanOrEqual(0);
    expect(moduleIndex).toBeGreaterThan(bootstrapIndex);
    expect(indexHtml).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/i);
    expect(bootstrap).toContain("#ffffff");
    expect(bootstrap).toContain("#161616");
    expect(bootstrap).toContain("tokens.css");
    expect(bootstrap).toContain("omp:workspace:v1");
  });

  it("boots app-wire hello and image decoders without native Object.hasOwn", () => {
    const originalHasOwn = Object.getOwnPropertyDescriptor(Object, "hasOwn");
    try {
      Object.defineProperty(Object, "hasOwn", {
        configurable: true,
        writable: true,
        value: undefined,
      });
      const doc = {
        documentElement: {
          classList: { add: () => undefined },
          style: {} as Record<string, string>,
          dataset: {} as Record<string, string>,
        },
      };
      const runBootstrap = new Function(
        "document",
        "localStorage",
        "matchMedia",
        "location",
        "window",
        bootstrap,
      );
      runBootstrap(
        doc,
        { getItem: () => null },
        () => ({ matches: false }),
        { hash: "" },
        { addEventListener: () => undefined },
      );
      expect(typeof Object.hasOwn).toBe("function");
      expect(
        decodeHello({
          v: "omp-app/1",
          type: "hello",
          protocol: { min: "omp-app/1", max: "omp-app/1" },
          client: { name: "T4 Code", version: "test", build: "test", platform: "android" },
          requestedFeatures: ["transcript.images"],
          savedCursors: [],
          authentication: { deviceId: "android", deviceToken: "A".repeat(43) },
        }),
      ).toMatchObject({ type: "hello", requestedFeatures: ["transcript.images"] });
      expect(
        decodeCommandResult("session.image.read", {
          sha256: "a".repeat(64),
          mimeType: "image/png",
          size: 1,
          offset: 0,
          nextOffset: 1,
          complete: true,
          content: "AA==",
        }),
      ).toMatchObject({ mimeType: "image/png", complete: true });
    } finally {
      if (originalHasOwn === undefined) delete (Object as { hasOwn?: unknown }).hasOwn;
      else Object.defineProperty(Object, "hasOwn", originalHasOwn);
    }
  });
});
