import { expect, test } from "@playwright/test";
import { BuiltWebServer } from "./built-web-server.ts";

let web: BuiltWebServer;

test.beforeAll(async () => {
  web = new BuiltWebServer();
  await web.start();
});

test.afterAll(async () => {
  await web?.stop();
});

test("reserves macOS traffic-light space only for native window chrome", async ({ page }) => {
  await page.goto(`${web.url}fixture?platform=darwin&reset=1`, {
    waitUntil: "domcontentloaded",
  });

  const titlebar = page.locator("header");
  await expect(titlebar).not.toHaveAttribute("data-window-chrome");
  await expect(titlebar).toHaveCSS("padding-left", "10px");

  await titlebar.evaluate((element) => element.setAttribute("data-window-chrome", "darwin"));
  await expect(titlebar).toHaveCSS("padding-left", "76px");
  await expect(titlebar.getByRole("button", { name: /session list/u })).toBeVisible();
});

test("installs from the hosted-client titlebar without overflowing a phone", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(web.url, { waitUntil: "domcontentloaded" });

  const install = page.getByRole("button", { name: "Install T4 Code", exact: true });
  await expect(install).toBeVisible();
  await expect(install).toHaveCSS("width", "44px");
  const titlebarFits = await page.locator("header").evaluate((header) => {
    const bounds = header.getBoundingClientRect();
    return (
      header.scrollWidth <= header.clientWidth && bounds.left >= 0 && bounds.right <= innerWidth
    );
  });
  expect(titlebarFits).toBe(true);

  await install.click();
  await expect(
    page.getByText("Open the browser menu, then choose Install app or Add to Home screen."),
  ).toBeVisible();
  await page.keyboard.press("Escape");

  await page.evaluate(() => {
    const state = { promptCalls: 0 };
    Object.assign(globalThis, { __t4InstallPromptState: state });
    const promptEvent = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(promptEvent, {
      prompt: async () => {
        state.promptCalls += 1;
      },
      userChoice: Promise.resolve({ outcome: "dismissed" }),
    });
    window.dispatchEvent(promptEvent);
  });
  await install.click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            globalThis as typeof globalThis & {
              __t4InstallPromptState: { promptCalls: number };
            }
          ).__t4InstallPromptState.promptCalls,
      ),
    )
    .toBe(1);

  await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
  await expect(page.getByRole("button", { name: "Install T4 Code", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reload T4 Code", exact: true })).toHaveCount(0);
});

test("offers reload only from an installed standalone launch", async ({ page }) => {
  await page.addInitScript(() => {
    const browserMatchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query: string) => {
      if (query !== "(display-mode: standalone)") return browserMatchMedia(query);
      return {
        matches: true,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => true,
      } as MediaQueryList;
    };
  });
  await page.goto(web.url, { waitUntil: "domcontentloaded" });

  await expect(page.getByRole("button", { name: "Reload T4 Code", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Install T4 Code", exact: true })).toHaveCount(0);
});

test("serves a browser-readable standalone manifest", async ({ page }) => {
  await page.goto(web.url, { waitUntil: "domcontentloaded" });
  const manifestUrl = new URL("manifest.webmanifest", web.url).toString();
  const response = await page.request.get(manifestUrl);
  expect(response.ok()).toBe(true);
  expect(response.headers()["content-type"]).toBe("application/manifest+json; charset=utf-8");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "./manifest.webmanifest",
  );
  expect(await response.json()).toMatchObject({
    id: "./",
    name: "T4 Code",
    start_url: "./",
    scope: "./",
    display: "standalone",
  });
});

test("keeps the compaction lifecycle precise inside a 320px viewport", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await page.clock.install();
  await page.goto(
    `${web.url}fixture?reset=1&session=sess-stream&transcript=compaction#/sessions/sess-stream`,
    { waitUntil: "domcontentloaded" },
  );

  // Let the keyed timeline finish its cold-mount handoff without reaching the
  // fixture's compaction -> turn transition at 700ms.
  await page.clock.runFor(250);
  await expect(page.locator("[data-cold-mount-overlay]")).toHaveCount(0);

  const compacting = page.locator('[data-transcript-status="compacting-context"]');
  await expect(compacting).toHaveCount(1);
  await expect(compacting).toContainText("Compacting context for 1m 30s");

  const announcer = page.locator("[data-session-activity-announcer]");
  await expect(announcer).toHaveCount(1);
  await expect(announcer).toHaveText("Compacting context");
  await expect(compacting.locator('[role="status"], [aria-live]')).toHaveCount(0);

  const geometry = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    documentScrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    statusRight:
      document
        .querySelector<HTMLElement>('[data-transcript-status="compacting-context"]')
        ?.getBoundingClientRect().right ?? Number.POSITIVE_INFINITY,
  }));
  expect(geometry.documentScrollWidth).toBe(geometry.clientWidth);
  expect(geometry.bodyScrollWidth).toBe(geometry.clientWidth);
  expect(geometry.statusRight).toBeLessThanOrEqual(geometry.clientWidth + 0.5);

  // Capture the first committed text from the same keyed row. The elapsed
  // child must take the new turn start immediately, not one timer tick later.
  await page.evaluate(() => {
    const state: { firstWorkingText: string | null } = { firstWorkingText: null };
    const capture = () => {
      const working = document.querySelector<HTMLElement>('[data-transcript-status="working"]');
      if (working !== null && state.firstWorkingText === null) {
        state.firstWorkingText = working.textContent?.replaceAll(/\s+/gu, " ").trim() ?? "";
      }
    };
    const observer = new MutationObserver(capture);
    observer.observe(document.body, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    Object.assign(globalThis, { __t4CompactionRerender: { observer, state } });
  });
  await page.clock.runFor(500);
  await expect(page.locator('[data-transcript-status="working"]')).toHaveCount(1);

  const firstWorkingText = await page.evaluate(
    () =>
      (
        globalThis as typeof globalThis & {
          __t4CompactionRerender: {
            observer: MutationObserver;
            state: { firstWorkingText: string | null };
          };
        }
      ).__t4CompactionRerender.state.firstWorkingText,
  );
  expect(firstWorkingText).toBe("Working for 30s");
  await expect(announcer).toHaveText("Context compaction complete. Working");

  await page.evaluate(() => {
    (
      globalThis as typeof globalThis & {
        __t4CompactionRerender: { observer: MutationObserver };
      }
    ).__t4CompactionRerender.observer.disconnect();
  });
});
