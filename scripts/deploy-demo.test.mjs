import assert from "node:assert/strict";
import test from "node:test";

import { buildDemo } from "./build-demo.mjs";
import { assertDemoDocumentPaths, deployDemo } from "./deploy-demo.mjs";

test("demo build compiles the React client for the /demo/ path", () => {
  const calls = [];
  buildDemo("/repo", (command, args, cwd) => calls.push({ command, args, cwd }));

  assert.deepEqual(calls, [
    {
      command: "pnpm",
      args: [
        "--filter",
        "@t4-code/web",
        "exec",
        "vp",
        "build",
        "--mode",
        "demo",
        "--outDir",
        "/repo/apps/site/dist/demo",
      ],
      cwd: "/repo",
    },
  ]);
});

test("site workflow deploys the React demo independently from release publication", async () => {
  const { readFile } = await import("node:fs/promises");
  const workflow = await readFile(".github/workflows/deploy-site.yml", "utf8");
  const infrastructure = await readFile("infra/site/cloudformation.yml", "utf8");

  assert.match(workflow, /- "apps\/web\/\*\*"/u);
  assert.match(workflow, /demo:\n    if: \$\{\{ github\.event_name == 'push' \}\}/u);
  assert.doesNotMatch(workflow, /flutter-action/u);
  assert.match(workflow, /run: pnpm deploy:demo/u);
  assert.match(workflow, /run: pnpm deploy:site/u);
  assert.doesNotMatch(workflow, /deploy:site-bundle/u);
  assert.equal(
    workflow.match(/name: Authenticate to AWS with deployment credentials/gu)?.length,
    2,
  );
  assert.equal(workflow.match(/aws-access-key-id: \$\{\{ secrets\.AWS_ACCESS_KEY_ID \}\}/gu)?.length, 2);
  assert.equal(
    workflow.match(/aws-secret-access-key: \$\{\{ secrets\.AWS_SECRET_ACCESS_KEY \}\}/gu)?.length,
    2,
  );
  assert.equal(workflow.match(/vars\.AWS_ROLE_ARN == ''/gu)?.length, 2);
  assert.equal(workflow.match(/vars\.AWS_ROLE_ARN != ''/gu)?.length, 2);
  assert.match(infrastructure, /PathPattern: demo\*/u);
  assert.match(infrastructure, /connect-src 'self' https:\/\/fonts\.gstatic\.com/u);
});

test("demo deploy replaces only the demo prefix after immutable assets", () => {
  const calls = [];
  deployDemo(
    { bucket: "t4code-net-site-595529182031", distributionId: "E1ABCDEF234567" },
    "/repo",
    (command, args, cwd) => calls.push({ command, args, cwd }),
    () => undefined,
  );

  assert.equal(calls.length, 4);
  assert.deepEqual(calls[0], { command: "pnpm", args: ["build:demo"], cwd: "/repo" });
  assert.equal(calls[1].args[2], "apps/site/dist/demo/assets");
  assert.equal(calls[1].args[3], "s3://t4code-net-site-595529182031/demo/assets");
  assert.equal(calls[1].args.includes("--delete"), false);
  assert.equal(calls[2].args[2], "apps/site/dist/demo");
  assert.equal(calls[2].args[3], "s3://t4code-net-site-595529182031/demo");
  assert.equal(calls[2].args.includes("--delete"), true);
  assert.deepEqual(calls[3].args.slice(-3), ["--paths", "/demo", "/demo/*"]);
  assert.deepEqual(
    calls.map(({ cwd }) => cwd),
    ["/repo", "/repo", "/repo", "/repo"],
  );
});

test("demo build keeps every local document URL under /demo", () => {
  assert.doesNotThrow(() =>
    assertDemoDocumentPaths(
      '<base href="/demo/"><link href="/demo/assets/app.css"><script src="/demo/assets/app.js"></script>',
    ),
  );
  assert.throws(
    () =>
      assertDemoDocumentPaths(
        '<base href="/demo/"><script src="/demo/assets/app.js"></script><script src="/assets/app.js"></script>',
      ),
    /demo asset escapes/u,
  );
  assert.throws(
    () =>
      assertDemoDocumentPaths(
        '<base href="/demo/"><script src="/demo/assets/app.js"></script><script src="//other.example/app.js"></script>',
      ),
    /demo asset escapes/u,
  );
  assert.throws(
    () => assertDemoDocumentPaths('<base href="/"><script src="/demo/assets/app.js"></script>'),
    /base href/u,
  );
  assert.throws(
    () => assertDemoDocumentPaths('<base href="/demo/"><script src="app.js"></script>'),
    /not a React production build/u,
  );
});
