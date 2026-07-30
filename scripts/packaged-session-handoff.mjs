#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import {
  prepareDevelopmentSandbox,
  resetDevelopmentSandbox,
  sandboxEnvironment,
} from "./dev-sandbox.mjs";

const TIMEOUT_MS = 60_000;

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function requiredOption(name) {
  const value = option(name);
  if (value === undefined) throw new Error(`missing --${name}`);
  return resolve(value);
}

async function startDeterministicModel() {
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end("not found");
      return;
    }
    request.resume();
    const id = "chatcmpl-packaged-handoff";
    const events = [
      {
        id,
        object: "chat.completion.chunk",
        created: 0,
        model: "deterministic",
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Packaged handoff ready" },
            finish_reason: null,
          },
        ],
      },
      {
        id,
        object: "chat.completion.chunk",
        created: 0,
        model: "deterministic",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
      },
    ];
    const payload = `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(payload);
  });
  await new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("deterministic model did not bind TCP");
  return {
    port: address.port,
    close: () =>
      new Promise((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      }),
  };
}

async function sessionFiles(root) {
  const files = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return files;
    throw error;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await sessionFiles(path)));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
}

async function createSession(runtime, paths, project, environment) {
  const expectScript = `
set timeout 15
spawn -noecho $env(T4_HANDOFF_RUNTIME) --cwd $env(T4_HANDOFF_PROJECT) --model handoff/deterministic --no-tools --no-lsp --no-skills --no-rules "Packaged handoff seed"
after 8000
send -- "/exit\\r"
expect eof
`;
  const child = spawn("/usr/bin/expect", ["-c", expectScript], {
    cwd: project,
    env: {
      ...environment,
      T4_HANDOFF_RUNTIME: runtime,
      T4_HANDOFF_PROJECT: project,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exitCode = await Promise.race([
    new Promise((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("exit", resolvePromise);
    }),
    new Promise((resolvePromise) =>
      setTimeout(() => {
        child.kill("SIGKILL");
        resolvePromise(null);
      }, TIMEOUT_MS),
    ),
  ]);
  if (exitCode !== 0)
    throw new Error(
      `OMP seed failed (${String(exitCode)}): ${(stderr || stdout).slice(-2048)}`,
    );
  const files = await sessionFiles(join(paths.agent, "sessions"));
  if (files.length !== 1) {
    throw new Error(
      `OMP seed created ${files.length} session files: ${(stderr || stdout).slice(-2048)}`,
    );
  }
  const sessionPath = files[0];
  const entries = (await readFile(sessionPath, "utf8"))
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const header = entries.find((entry) => entry.type === "session");
  if (
    header === undefined ||
    typeof header.id !== "string" ||
    header.authorityProtocol !== "t4-omp-authority/1"
  ) {
    throw new Error("OMP seed did not create an authority-marked session");
  }
  const firstUserText = entries
    .find((entry) => entry.type === "message" && entry.message?.role === "user")
    ?.message?.content?.find((part) => part?.type === "text")?.text;
  return {
    sessionId: header.id,
    sessionPath,
    title:
      typeof firstUserText === "string" && firstUserText.length > 0
        ? firstUserText
        : "New Session",
  };
}

function startTerminalResume(launcher, sessionId, project, environment) {
  const expectScript = `
set timeout -1
spawn -noecho $env(T4_HANDOFF_LAUNCHER) --resume $env(T4_HANDOFF_SESSION)
puts "T4_HANDOFF_TERMINAL_STARTED"
flush stdout
gets stdin instruction
if {$instruction ne "exit"} {
  exit 2
}
send -- "/exit\\r"
expect eof
`;
  const child = spawn("/usr/bin/expect", ["-c", expectScript], {
    cwd: project,
    env: {
      ...environment,
      T4_HANDOFF_LAUNCHER: launcher,
      T4_HANDOFF_SESSION: sessionId,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const exited = new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolvePromise(code));
  });
  return { child, exited, output: () => output };
}

async function stopChild(child) {
  if (child === undefined || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    new Promise((resolvePromise) =>
      setTimeout(() => {
        child.kill("SIGKILL");
        resolvePromise();
      }, 5_000),
    ),
  ]);
}

async function launchPackagedApp(executablePath, environment) {
  const child = spawn(
    executablePath,
    ["--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0"],
    {
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const endpoint = await Promise.race([
    new Promise((resolvePromise, reject) => {
      const inspect = () => {
        const match = output.match(
          /DevTools listening on (ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[^\s]+)/u,
        );
        if (match?.[1]) resolvePromise(match[1]);
      };
      child.stdout.on("data", inspect);
      child.stderr.on("data", inspect);
      child.once("error", reject);
      child.once("exit", (code) =>
        reject(
          new Error(
            `packaged app exited before DevTools (${code}): ${output.slice(-4096)}`,
          ),
        ),
      );
      inspect();
    }),
    new Promise((_, reject) =>
      setTimeout(
        () =>
          reject(
            new Error(`packaged app DevTools timeout: ${output.slice(-4096)}`),
          ),
        TIMEOUT_MS,
      ),
    ),
  ]);
  const browser = await chromium.connectOverCDP(endpoint);
  const page = await Promise.race([
    (async () => {
      for (;;) {
        const pages = browser.contexts().flatMap((context) => context.pages());
        const candidate = pages.find((value) =>
          value.url().startsWith("file:"),
        );
        if (candidate) return candidate;
        if (child.exitCode !== null)
          throw new Error(
            `packaged app exited before its renderer (${child.exitCode})`,
          );
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
      }
    })(),
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error("packaged app renderer timeout")),
        TIMEOUT_MS,
      ),
    ),
  ]);
  return { browser, child, page };
}

async function main() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("packaged session handoff requires Apple Silicon macOS");
  }
  const app = requiredOption("app");
  const artifactRoot = requiredOption("artifact-root");
  const sandboxWorkspaceRoot = join(homedir(), ".t4-op");
  const sandboxName = `handoff-${randomUUID().slice(0, 12)}`;
  const paths = await prepareDevelopmentSandbox(
    sandboxName,
    sandboxWorkspaceRoot,
  );
  let model;
  let launched;
  let terminal;
  let passed = false;
  try {
    const socketPath = join(paths.home, ".omp", "run", "appserver.sock");
    if (Buffer.byteLength(socketPath, "utf8") >= 104) {
      throw new Error(
        "packaged handoff sandbox socket path exceeds the macOS limit",
      );
    }
    const project = join(paths.root, "project");
    const launcherPath = join(paths.home, ".local", "bin", "t4-omp");
    model = await startDeterministicModel();
    await Promise.all([
      mkdir(project, { recursive: true }),
      mkdir(paths.agent, { recursive: true }),
    ]);
    await writeFile(
      join(paths.agent, "models.yml"),
      `providers:\n  handoff:\n    baseUrl: http://127.0.0.1:${model.port}/v1\n    api: openai-completions\n    auth: none\n    models:\n      - id: deterministic\n        name: Handoff deterministic\n        reasoning: false\n        input: [text]\n        contextWindow: 32768\n        maxTokens: 4096\n`,
      { mode: 0o600 },
    );
    await writeFile(
      join(paths.agent, "config.yml"),
      "setupVersion: 1\nstartup:\n  setupWizard: false\n  checkUpdate: false\n",
      { mode: 0o600 },
    );
    const executablePath = join(app, "Contents", "MacOS", "t4-code");
    const environment = sandboxEnvironment(paths, {
      ...process.env,
      OMP_PROFILE: "default",
      PI_NOTIFICATIONS: "off",
    });
    const seeded = await createSession(
      join(app, "Contents", "Resources", "runtime", "omp"),
      paths,
      project,
      environment,
    );
    const { sessionId, sessionPath, title } = seeded;
    launched = await launchPackagedApp(executablePath, environment);
    const { page } = launched;
    page.setDefaultTimeout(TIMEOUT_MS);
    await page.waitForLoadState("domcontentloaded");
    const sessionTitle = page.getByText(title, { exact: true }).first();
    try {
      await sessionTitle.waitFor({ state: "visible" });
    } catch (error) {
      await mkdir(artifactRoot, { recursive: true });
      await page.screenshot({
        path: join(artifactRoot, "packaged-session-handoff-failure.png"),
        fullPage: true,
      });
      const body = await page
        .locator("body")
        .innerText()
        .catch(() => "");
      const diagnostics = await page
        .evaluate(async () => {
          if (window.ompShell === undefined) {
            return { url: window.location.href, shell: "absent" };
          }
          const service = await window.ompShell.serviceInspect().then(
            (value) => ({ ok: true, value }),
            (reason) => ({ ok: false, reason: String(reason) }),
          );
          const targets = await window.ompShell.listTargets().then(
            (value) => ({ ok: true, value }),
            (reason) => ({ ok: false, reason: String(reason) }),
          );
          return {
            url: window.location.href,
            shell: "present",
            service,
            targets,
          };
        })
        .catch((reason) => ({ diagnosticsError: String(reason) }));
      throw new Error(
        `packaged session did not appear: ${body.slice(0, 4096)}\ndiagnostics: ${JSON.stringify(diagnostics)}`,
        { cause: error },
      );
    }
    await sessionTitle.click();

    const composer = page.getByRole("textbox", { name: "Message the session" });
    await composer.waitFor({ state: "visible" });
    try {
      await page.waitForFunction(
        () => {
          const textarea = document.querySelector(
            'textarea[aria-label="Message the session"]',
          );
          return textarea instanceof HTMLTextAreaElement && !textarea.disabled;
        },
        undefined,
        { timeout: TIMEOUT_MS },
      );
    } catch (error) {
      const body = await page
        .locator("body")
        .innerText()
        .catch(() => "");
      throw new Error(
        `packaged seed did not become writable: ${body.slice(0, 4096)}`,
        { cause: error },
      );
    }

    const launcher = await page.evaluate(async () => {
      if (window.ompShell === undefined)
        throw new Error("packaged preload bridge is unavailable");
      return window.ompShell.installT4OmpLauncher();
    });
    if (launcher.phase !== "installed") {
      throw new Error(`t4-omp launcher was not installed: ${launcher.phase}`);
    }

    await page.getByRole("button", { name: `Actions for ${title}` }).click();
    await page
      .getByRole("button", { name: "Continue in terminal", exact: true })
      .click();
    const releaseDialog = page
      .getByRole("dialog")
      .filter({ hasText: `Continue “${title}” in a terminal` });
    try {
      await releaseDialog.waitFor({ state: "visible" });
    } catch (error) {
      await mkdir(artifactRoot, { recursive: true });
      await page.screenshot({
        path: join(artifactRoot, "packaged-session-release-failure.png"),
        fullPage: true,
      });
      const body = await page
        .locator("body")
        .innerText()
        .catch(() => "");
      throw new Error(
        `terminal release dialog did not open: ${body.slice(0, 4096)}`,
        { cause: error },
      );
    }
    await releaseDialog
      .getByRole("button", { name: "Release session" })
      .click();
    const command = releaseDialog.locator("code");
    await command.waitFor({ state: "visible" });
    const resumeCommand = (await command.textContent())?.trim();
    if (resumeCommand !== `t4-omp --resume ${sessionId}`) {
      throw new Error(
        `unexpected terminal resume command: ${String(resumeCommand)}`,
      );
    }
    await releaseDialog.getByRole("button", { name: "Done" }).click();

    terminal = startTerminalResume(
      launcherPath,
      sessionId,
      project,
      environment,
    );
    try {
      await Promise.race([
        page
          .getByLabel("Active elsewhere", { exact: true })
          .waitFor({ state: "visible" }),
        terminal.exited.then((code) => {
          throw new Error(
            `terminal launcher exited before taking control (${String(code)}): ${terminal.output().slice(-4096)}`,
          );
        }),
      ]);
    } catch (error) {
      await mkdir(artifactRoot, { recursive: true });
      await page.screenshot({
        path: join(artifactRoot, "packaged-session-terminal-failure.png"),
        fullPage: true,
      });
      const body = await page
        .locator("body")
        .innerText()
        .catch(() => "");
      throw new Error(
        `terminal resume did not take control: ${body.slice(0, 4096)}\nterminal: ${terminal.output().slice(-4096)}`,
        { cause: error },
      );
    }

    terminal.child.stdin.end("exit\n");
    const terminalExit = await terminal.exited;
    if (terminalExit !== 0) {
      throw new Error(
        `terminal launcher failed (${String(terminalExit)}): ${terminal.output().slice(-4096)}`,
      );
    }
    await page.waitForFunction(
      () => {
        const textarea = document.querySelector(
          'textarea[aria-label="Message the session"]',
        );
        return textarea instanceof HTMLTextAreaElement && !textarea.disabled;
      },
      undefined,
      { timeout: TIMEOUT_MS },
    );
    await page
      .getByLabel("Active elsewhere", { exact: true })
      .waitFor({ state: "hidden" });
    await mkdir(artifactRoot, { recursive: true });
    await page.screenshot({
      path: join(artifactRoot, "packaged-session-handoff.png"),
      fullPage: true,
    });
    await writeFile(
      join(artifactRoot, "packaged-session-handoff.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          sessionId,
          sessionPath,
          launcher: "~/.local/bin/t4-omp",
          states: ["writable", "released", "active-elsewhere", "writable"],
          passed: true,
        },
        null,
        2,
      )}\n`,
    );
    passed = true;
  } finally {
    await stopChild(terminal?.child);
    await launched?.browser.close().catch(() => undefined);
    await stopChild(launched?.child);
    await model?.close().catch(() => undefined);
    await resetDevelopmentSandbox(sandboxName, sandboxWorkspaceRoot);
  }
  if (!passed) throw new Error("packaged session handoff did not complete");
}

await main();
