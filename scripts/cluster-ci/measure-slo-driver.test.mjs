import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { once } from "node:events";
import { WebSocketServer } from "ws";

import {
  CommandRunner,
  Deadline,
  WebSocketTransport,
  IterationLifecycle,
  chartIdentity,
  classifyOwnedStorage,
  conditionTrue,
  deploymentBaseline,
  extractRenderedImages,
  liveWriterInvariant,
  requireLedgerEnvironmentFleet,
  requireLedgerEnvironmentMatch,
  measureControlPlane,
  resumedCursor,
  withinDeadline,
  routeAndFenceReady,
} from "./measure-slo-driver.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const harness = resolve(import.meta.dirname, "measure-slo.sh");
const controllerImage = `registry.example/controller@sha256:${"a".repeat(64)}`;
const serverImage = `registry.example/server@sha256:${"b".repeat(64)}`;
const runtimeImage = `registry.example/runtime@sha256:${"c".repeat(64)}`;

function run(command, args, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", rejectRun);
    child.on("close", code => resolveRun({ code, stdout, stderr }));
  });
}

function readySession(overrides = {}) {
  return {
    metadata: { generation: 3, uid: "session-uid" },
    spec: { publicId: "rt-public" },
    status: {
      observedGeneration: 3,
      runtimeGeneration: "gen_new-generation",
      fenceState: "FenceProven",
      conditions: [{ type: "RouteReady", status: "True", observedGeneration: 3 }],
    },
    ...overrides,
  };
}

function pod(uid, generation, ready = true) {
  return {
    metadata: { uid, annotations: { "cluster.t4.dev/runtime-generation": generation } },
    status: { phase: "Running", conditions: [{ type: "Ready", status: ready ? "True" : "False" }] },
  };
}

function lease(uid, holder, generation) {
  return { metadata: { uid, annotations: { "cluster.t4.dev/runtime-generation": generation } }, spec: { holderIdentity: holder } };
}

test("session and fencing state machines require exact generation, fence, route, identity, and one writer", () => {
  const session = readySession();
  assert.equal(routeAndFenceReady(session, "gen_old-generation"), true);
  assert.equal(routeAndFenceReady(session, "gen_new-generation"), false);
  assert.equal(routeAndFenceReady(readySession({ status: { ...session.status, fenceState: "FenceUncertain" } }), "gen_old-generation"), false);
  assert.equal(conditionTrue(session, "RouteReady"), true);
  assert.equal(conditionTrue(readySession({ status: { ...session.status, conditions: [{ type: "RouteReady", status: "True" }] } }), "RouteReady"), false);
  assert.equal(conditionTrue(readySession({ status: { ...session.status, conditions: [{ type: "RouteReady", status: "True", observedGeneration: 2 }] } }), "RouteReady"), false);
  assert.equal(conditionTrue(readySession({ status: { ...session.status, conditions: [{ type: "RouteReady", status: "True", observedGeneration: "3" }] } }), "RouteReady"), false);
  assert.equal(conditionTrue(readySession({ metadata: { ...session.metadata, generation: 3.5 } }), "RouteReady"), false);
  assert.equal(conditionTrue(readySession({ metadata: { uid: session.metadata.uid } }), "RouteReady"), false);
  const workspace = { metadata: { generation: 7 }, status: { conditions: [{ type: "Ready", status: "True", observedGeneration: 7 }] } };
  assert.equal(conditionTrue(workspace, "Ready"), true);
  assert.equal(conditionTrue({ ...workspace, status: { conditions: [{ type: "Ready", status: "True" }] } }, "Ready"), false);
  assert.equal(conditionTrue({ ...workspace, status: { conditions: [{ type: "Ready", status: "True", observedGeneration: 6 }] } }, "Ready"), false);
  assert.equal(conditionTrue({ ...workspace, status: { conditions: [{ type: "Ready", status: "True", observedGeneration: 7.1 }] } }, "Ready"), false);
  assert.equal(conditionTrue({ ...workspace, metadata: {} }, "Ready"), false);
  assert.equal(routeAndFenceReady(readySession({ status: { ...session.status, conditions: [{ type: "RouteReady", status: "True" }] } }), "gen_old-generation"), false);
  assert.equal(routeAndFenceReady(readySession({ status: { ...session.status, conditions: [{ type: "RouteReady", status: "True", observedGeneration: 2 }] } }), "gen_old-generation"), false);
  assert.equal(routeAndFenceReady(readySession({ status: { ...session.status, observedGeneration: "3" } }), "gen_old-generation"), false);
  assert.equal(routeAndFenceReady(readySession({ status: { ...session.status, observedGeneration: undefined } }), "gen_old-generation"), false);

  const held = liveWriterInvariant({
    session,
    previousGeneration: "gen_old-generation",
    previousPublicId: "rt-public",
    pods: [pod("pod-new", "gen_new-generation")],
    leases: [lease("lease-new", "pod-new", "gen_new-generation")],
  });
  assert.equal(held.held, true);
  assert.deepEqual(held.reasons, []);

  const splitBrain = liveWriterInvariant({
    session,
    previousGeneration: "gen_old-generation",
    previousPublicId: "rt-public",
    pods: [pod("pod-new", "gen_new-generation"), pod("pod-other", "gen_new-generation")],
    leases: [lease("lease-new", "pod-new", "gen_new-generation")],
  });
  assert.equal(splitBrain.held, false);
  assert.ok(splitBrain.reasons.includes("active-session-writers=2"));

  const staleAuthority = liveWriterInvariant({
    session,
    previousGeneration: "gen_old-generation",
    previousPublicId: "rt-public",
    pods: [pod("pod-new", "gen_new-generation"), pod("pod-old", "gen_old-generation", false), pod("pod-unknown", undefined)],
    leases: [lease("lease-new", "pod-new", "gen_new-generation"), lease("lease-old", "pod-old", "gen_old-generation")],
  });
  assert.equal(staleAuthority.held, false);
  assert.ok(staleAuthority.reasons.includes("active-session-writers=3"));
  assert.ok(staleAuthority.reasons.includes("held-session-writer-leases=2"));
  assert.equal(staleAuthority.snapshots.pods.length, 3);
  assert.equal(staleAuthority.snapshots.leases.length, 2);

  const changedIdentity = liveWriterInvariant({
    session: readySession({ spec: { publicId: "rt-changed" } }),
    previousGeneration: "gen_old-generation",
    previousPublicId: "rt-public",
    pods: [pod("pod-new", "gen_new-generation")],
    leases: [lease("lease-new", "pod-new", "gen_new-generation")],
  });
  assert.equal(changedIdentity.held, false);
  assert.ok(changedIdentity.reasons.includes("public-id-changed"));
});

test("one monotonic deadline never resets and healthy Deployment baselines are exact", async () => {
  const deadline = new Deadline(20, "deterministic test");
  const first = deadline.remainingMs();
  await new Promise(resolveWait => setTimeout(resolveWait, 5));
  assert.ok(deadline.remainingMs() < first);
  await new Promise(resolveWait => setTimeout(resolveWait, 20));
  assert.throws(() => deadline.remainingMs(), /deterministic test deadline expired/u);

  await assert.rejects(
    withinDeadline(new Deadline(10, "hung REST"), signal => new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })),
    /hung REST deadline expired/u,
  );
  const deployment = {
    metadata: { uid: "deployment-uid", generation: 7 },
    spec: { replicas: 2 },
    status: { observedGeneration: 7, readyReplicas: 2, availableReplicas: 2 },
  };
  assert.deepEqual(deploymentBaseline(deployment), { uid: "deployment-uid", generation: 7, desired: 2 });
  assert.throws(() => deploymentBaseline({ ...deployment, status: { ...deployment.status, readyReplicas: 1 } }), /every desired replica Ready and Available/u);
  assert.throws(() => deploymentBaseline({ ...deployment, status: { ...deployment.status, observedGeneration: 6 } }), /current Deployment generation/u);
});

test("iteration lifecycle aborts measurement before cooperatively completing cleanup", async () => {
  const lifecycle = new IterationLifecycle();
  const order = [];
  lifecycle.own(async () => { order.push("resource"); });
  lifecycle.own(async () => { order.push("recovery"); });
  await assert.rejects(
    withinDeadline(new Deadline(10, "iteration"), signal => new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        lifecycle.abort(signal.reason);
        reject(signal.reason);
      }, { once: true });
    })),
    /iteration deadline expired/u,
  );
  await lifecycle.cleanup();
  assert.deepEqual(order, ["recovery", "resource"]);
});

test("storage fingerprint accepts only exact release-owned workspace and runtime-state PVCs", () => {
  const host = {
    metadata: { name: "host-a", namespace: "team", labels: { "app.kubernetes.io/instance": "release-a" } },
    spec: { storageClassName: "workspace-rwx", runtimeStateStorageProfile: { storageClassName: "runtime-rwop", accessMode: "ReadWriteOncePod" } },
  };
  const workspace = {
    metadata: { name: "workspace-a", namespace: "team", uid: "workspace-uid" },
    spec: { hostRef: "host-a" },
    status: { pvcName: "workspace-pvc", selectedStorageClassName: "workspace-rwx" },
  };
  const session = {
    metadata: { name: "session-a", namespace: "team", uid: "session-uid" },
    spec: { hostRef: "host-a" },
    status: { runtimeStatePVCName: "runtime-pvc", runtimeStateStorageClassName: "runtime-rwop" },
  };
  const workspacePvc = {
    metadata: { name: "workspace-pvc", namespace: "team", uid: "workspace-pvc-uid", annotations: { "cluster.t4.dev/workspace-uid": "workspace-uid" } },
    spec: { storageClassName: "workspace-rwx", accessModes: ["ReadWriteMany"], volumeName: "workspace-pv" },
    status: { phase: "Bound" },
  };
  const runtimePvc = {
    metadata: { name: "runtime-pvc", namespace: "team", uid: "runtime-pvc-uid", ownerReferences: [{ kind: "T4Session", uid: "session-uid", controller: true }] },
    spec: { storageClassName: "runtime-rwop", accessModes: ["ReadWriteOncePod"], volumeName: "runtime-pv" },
    status: { phase: "Bound" },
  };
  const unrelated = {
    metadata: { name: "runtime-pvc", namespace: "unrelated", uid: "foreign", ownerReferences: [{ kind: "T4Session", uid: "session-uid", controller: true }] },
    spec: { storageClassName: "runtime-rwop", accessModes: ["ReadWriteOncePod"], volumeName: "foreign-pv" },
    status: { phase: "Bound" },
  };
  const result = classifyOwnedStorage({
    namespace: "team",
    release: "release-a",
    hosts: [host, { ...host, metadata: { name: "foreign-host", labels: { "app.kubernetes.io/instance": "other-release" } } }],
    workspaces: [workspace],
    sessions: [session],
    pvcs: [workspacePvc, runtimePvc, unrelated],
    storageClasses: [
      { metadata: { name: "workspace-rwx" }, provisioner: "csi.workspace.example" },
      { metadata: { name: "runtime-rwop" }, provisioner: "csi.runtime.example" },
    ],
  });
  assert.equal(result.workspace.length, 1);
  assert.equal(result.runtimeState.length, 1);
  assert.equal(result.runtimeState[0].volumeName, "runtime-pv");
  assert.throws(() => classifyOwnedStorage({
    namespace: "team",
    release: "release-a",
    hosts: [host],
    workspaces: [workspace],
    sessions: [session],
    pvcs: [workspacePvc, unrelated],
    storageClasses: [
      { metadata: { name: "workspace-rwx" }, provisioner: "csi.workspace.example" },
      { metadata: { name: "runtime-rwop" }, provisioner: "csi.runtime.example" },
    ],
  }), /owned authoritative runtime-state PVC/u);
});
test("cold environments bind an exact context-keyed fleet while reused contexts stay singular", () => {
  const first = { clusterUid: "cluster-a", nodes: [{ uid: "node-a" }] };
  const second = { clusterUid: "cluster-b", nodes: [{ uid: "node-b" }] };
  const ledger = { environment: { fingerprint: { contexts: [
    { context: "cold-a", fingerprint: first },
    { context: "cold-b", fingerprint: second },
  ] } } };
  assert.doesNotThrow(() => requireLedgerEnvironmentMatch(ledger, first, "cold-a", "control-plane-cold-start"));
  assert.doesNotThrow(() => requireLedgerEnvironmentFleet(ledger, [{ context: "cold-a" }, { context: "cold-b" }], "control-plane-cold-start"));
  assert.throws(() => requireLedgerEnvironmentMatch(ledger, second, "cold-a", "control-plane-cold-start"), /does not exactly match/u);
  assert.throws(() => requireLedgerEnvironmentFleet(ledger, [{ context: "cold-a" }], "control-plane-cold-start"), /set\/count/u);
  assert.throws(() => requireLedgerEnvironmentMatch(ledger, first, "cold-a", "gateway-replica-failover"), /singular/u);
  assert.doesNotThrow(() => requireLedgerEnvironmentMatch({ environment: { fingerprint: first } }, first, "stable", "gateway-replica-failover"));
});

test("cursor resume accepts only the same epoch at or beyond the saved cursor", () => {
  assert.equal(resumedCursor({ epoch: "session-epoch", seq: 8 }, { epoch: "session-epoch", seq: 8 }), true);
  assert.equal(resumedCursor({ epoch: "session-epoch", seq: 8 }, { epoch: "session-epoch", seq: 9 }), true);
  assert.equal(resumedCursor({ epoch: "session-epoch", seq: 8 }, { epoch: "session-epoch", seq: 7 }), false);
  assert.equal(resumedCursor({ epoch: "session-epoch", seq: 8 }, { epoch: "other", seq: 99 }), false);
});

test("rendered image extraction accepts ordinary and YAML sequence image keys", () => {
  assert.deepEqual(
    extractRenderedImages(`image: "${controllerImage}"\n  - image: '${serverImage}'\n    image: ${runtimeImage}\n`),
    [controllerImage, serverImage, runtimeImage],
  );
});

test("chart identity accepts regular archives and symlink-free directory trees", async () => {
  const root = await mkdtemp(join(tmpdir(), "t4-slo-chart-"));
  const archive = join(root, "chart.tgz");
  await writeFile(archive, "regular archive bytes");
  const archiveIdentity = await chartIdentity(archive);
  assert.equal(archiveIdentity.kind, "archive");
  assert.equal(archiveIdentity.size, 21);
  const directory = join(root, "chart");
  await mkdir(join(directory, "templates"), { recursive: true });
  await writeFile(join(directory, "Chart.yaml"), "apiVersion: v2\nname: exact\nversion: 1.0.0\n");
  await writeFile(join(directory, "templates", "deployment.yaml"), "kind: Deployment\n");
  const directoryIdentity = await chartIdentity(directory);
  assert.equal(directoryIdentity.kind, "directory");
  assert.equal(directoryIdentity.files, 2);
  await symlink(archive, join(directory, "linked.tgz"));
  await assert.rejects(chartIdentity(directory), /refuses symbolic link/u);
});


test("WebSocket transport carries the real bearer-authenticated stream to a local protocol endpoint", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  assert.equal(typeof address, "object");
  const observed = Promise.withResolvers();
  server.once("connection", (socket, request) => {
    observed.resolve(request.headers.authorization);
    socket.send('{"v":"omp-app/1","type":"probe"}');
  });
  const transport = new WebSocketTransport(`ws://127.0.0.1:${address.port}`, "local-test-token", 1_000);
  const message = Promise.withResolvers();
  transport.onMessage(value => message.resolve(value.toString()));
  await transport.open();
  assert.equal(await observed.promise, "Bearer local-test-token");
  assert.equal(await message.promise, '{"v":"omp-app/1","type":"probe"}');
  transport.close();
  await new Promise(resolveClose => server.close(resolveClose));
});

test("CommandRunner bounds evidence and redacts argv, executable output, and primary command failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "t4-slo-runner-"));
  const raw = join(root, "commands.jsonl");
  await writeFile(raw, "");
  const runner = new CommandRunner(raw, 2);
  runner.runToken = "test-run-token";
  runner.scenario = "test-scenario";
  await assert.rejects(
    runner.run(process.execPath, ["-e", "process.stdout.write('token=stdout-secret\\n'); process.stderr.write('access_key=stderr-secret\\n'); process.exit(7)", "--", "--api-key", "argv-secret", "Bearer bearer-secret"]),
    error => /failed \(7\)/u.test(error.message) && !/stdout-secret|stderr-secret|argv-secret|bearer-secret/u.test(error.message),
  );
  const evidence = await readFile(raw, "utf8");
  assert.match(evidence, /<redacted>/u);
  assert.doesNotMatch(evidence, /stdout-secret|stderr-secret|argv-secret|bearer-secret/u);
  const commandRecord = JSON.parse(evidence);
  assert.equal(commandRecord.schemaVersion, "t4-slo-command/1");
  assert.equal(commandRecord.runToken, "test-run-token");
  assert.equal(commandRecord.scenario, "test-scenario");
  assert.equal(commandRecord.iteration, 0);
  assert.equal(commandRecord.eventSequence, 0);
  const marker = join(root, "must-not-run");
  runner.recordedBytes = 16 * 1024 * 1024 - 2047;
  await assert.rejects(
    runner.run(process.execPath, ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`]),
    /no capacity for another bounded record/u,
  );
  await assert.rejects(readFile(marker), error => error?.code === "ENOENT");
});

test("control-plane driver proves cold rendered images before install and cleans only its namespace", async () => {
  const root = await mkdtemp(join(tmpdir(), "t4-slo-control-"));
  const log = join(root, "commands.log");
  const raw = join(root, "raw.jsonl");
  const kubectl = join(root, "kubectl.mjs");
  const helm = join(root, "helm.mjs");
  const inspector = join(root, "inspect-image.mjs");
  await writeFile(raw, "");
  await writeFile(kubectl, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.COMMAND_LOG, "kubectl\\t" + process.argv.slice(2).join("\\t") + "\\n");
const args = process.argv.slice(2);
const joined = args.join(" ");
if (joined.includes("get namespace/slo-cold-")) process.exit(0);
if (joined.includes("get nodes")) { console.log('{"items":[{"metadata":{"name":"cold-node"},"spec":{},"status":{"conditions":[{"type":"Ready","status":"True"}]}}]}'); process.exit(0); }
if (joined.includes("get deployments")) {
  const controller = ${JSON.stringify(controllerImage)};
  const server = ${JSON.stringify(serverImage)};
  const runtime = ${JSON.stringify(runtimeImage)};
  console.log(JSON.stringify({items:[
    {metadata:{uid:"controller-uid",generation:1,labels:{"app.kubernetes.io/component":"controller"}},spec:{replicas:2,template:{spec:{containers:[{name:"controller",image:controller,env:[{name:"T4_SESSION_RUNTIME_IMAGE",value:runtime}]}]}}},status:{availableReplicas:2,readyReplicas:2,observedGeneration:1,conditions:[{type:"Available",status:"True"}]}},
    {metadata:{uid:"server-uid",generation:1,labels:{"app.kubernetes.io/component":"server"}},spec:{replicas:2,template:{spec:{containers:[{name:"server",image:server,env:[{name:"T4_BUILD_REVISION",value:"${"d".repeat(40)}"}]}]}}},status:{availableReplicas:2,readyReplicas:2,observedGeneration:1,conditions:[{type:"Available",status:"True"}]}}
  ]})); process.exit(0);
}
console.log('{}');
`);
  await writeFile(helm, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
appendFileSync(process.env.COMMAND_LOG, "helm\\t" + process.argv.slice(2).join("\\t") + "\\n");
if (process.argv[2] === "template") console.log(${JSON.stringify(`containers:\n  - image: ${controllerImage}\n  - image: ${serverImage}\n  - image: ${runtimeImage}\n`)});
`);
  await writeFile(inspector, `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(process.env.COMMAND_LOG, "inspect\\t" + args.join("\\t") + "\\n");
const value = flag => args[args.indexOf(flag) + 1];
console.log(JSON.stringify({schemaVersion:"t4-node-image-inspection/1",context:value("--context"),node:value("--node"),runtime:"containerd-test",complete:true,images:process.env.IMAGE_PRESENT === "true" ? [${JSON.stringify(controllerImage)}] : []}));
`);
  await chmod(kubectl, 0o755); await chmod(helm, 0o755); await chmod(inspector, 0o755);
  const previous = process.env.COMMAND_LOG; const previousPresent = process.env.IMAGE_PRESENT; process.env.COMMAND_LOG = log; delete process.env.IMAGE_PRESENT;
  try {
    const runner = new CommandRunner(raw, 2);
    runner.runToken = "test-run-token";
    runner.scenario = "control-plane-cold-start";
    const lifecycle = new IterationLifecycle();
    const result = await measureControlPlane(
      { runner, context: "cold-context", namespace: "slo-cold-1", clusterUid: "cluster-uid-1" },
      { kubectl, helm, release: "t4-cluster", chart: "chart", valuesFile: "values.yaml", controllerImage, serverImage, runtimeImage, commit: "d".repeat(40), timeoutSeconds: 2, cleanupTimeoutSeconds: 2, imageInspectorArgv: [inspector, "--context", "{context}", "--node", "{node}"] },
      lifecycle,
    );
    assert.ok(result.seconds >= 0);
    process.env.IMAGE_PRESENT = "true";
    await lifecycle.cleanup();
    await assert.rejects(
      measureControlPlane(
        { runner, context: "cold-context", namespace: "slo-cold-2", clusterUid: "cluster-uid-1" },
        { kubectl, helm, release: "t4-cluster", chart: "chart", valuesFile: "values.yaml", controllerImage, serverImage, runtimeImage, commit: "d".repeat(40), timeoutSeconds: 2, imageInspectorArgv: [inspector, "--context", "{context}", "--node", "{node}"] },
      ),
      /image cache prerequisite is not proven/u,
    );
  } finally {
    if (previous === undefined) delete process.env.COMMAND_LOG; else process.env.COMMAND_LOG = previous;
    if (previousPresent === undefined) delete process.env.IMAGE_PRESENT; else process.env.IMAGE_PRESENT = previousPresent;
  }
  const commands = (await readFile(log, "utf8")).trim().split("\n");
  const template = commands.findIndex(line => line.startsWith("helm\ttemplate\t"));
  const nodeProof = commands.findIndex(line => line.includes("get\tnodes"));
  const inspected = commands.filter(line => line.startsWith("inspect\t"));
  const install = commands.findIndex(line => line.startsWith("helm\tinstall\t"));
  const available = commands.findIndex(line => line.includes("get\tdeployments"));
  const uninstall = commands.findIndex(line => line.startsWith("helm\tuninstall\t"));
  const namespaceDelete = commands.findIndex(line => line.includes("delete\tnamespace/slo-cold-1"));
  assert.ok(template >= 0 && template < nodeProof && inspected.length === 2 && nodeProof < commands.indexOf(inspected[0]) && commands.indexOf(inspected[0]) < install && install < available && available < uninstall && uninstall < namespaceDelete, commands.join("\n"));
  assert.equal(commands.filter(line => line.startsWith("helm\tinstall\t")).length, 1);
  assert.equal(commands.filter(line => line.includes("delete\tnamespace/")).length, 1);
});

test("run mode refuses before invoking kubectl when mutation authority is not explicit", async () => {
  const root = await mkdtemp(join(tmpdir(), "t4-slo-refusal-"));
  const log = join(root, "kubectl.log");
  const kubectl = join(root, "kubectl");
  await writeFile(kubectl, `#!/bin/sh\nprintf 'called\\n' >>"$KUBECTL_LOG"\nexit 99\n`);
  await chmod(kubectl, 0o755);
  const result = await run(harness, ["--run", "session-warm-first-attach"], { ...process.env, KUBECTL: kubectl, KUBECTL_LOG: log });
  assert.equal(result.code, 64);
  assert.match(result.stderr, /T4_SLO_COMMIT is required/u);
  await assert.rejects(readFile(log, "utf8"), error => error?.code === "ENOENT");
});

test("plan names exact prerequisites and never advertises unsupported behavior", async () => {
  const result = await run(harness, ["--plan"], process.env);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /T4_SLO_COLD_CONTEXTS/u);
  assert.match(result.stdout, /T4_SLO_NODE_IMAGE_INSPECT_ARGV/u);
  assert.match(result.stdout, /t4-node-image-inspection\/1/u);
  assert.match(result.stdout, /run-manifest\.json/u);
  assert.match(result.stdout, /T4_SLO_IMAGE_PUBLICATION_MANIFEST/u);
  assert.match(result.stdout, /warmupIterations=0/u);
  assert.match(result.stdout, /requestStartedAtMs/u);
  assert.match(result.stdout, /T4_SLO_WHOLE_RUN_TIMEOUT_SECONDS/u);
  assert.match(result.stdout, /exact same.*baseline|exact baseline/su);
  assert.match(result.stdout, /invokes T4_SLO_NODE_FAILURE_ARGV/u);
  assert.match(result.stdout, /same instance reconnects/u);
  assert.match(result.stdout, /automatically replays the saved attached/u);
  assert.doesNotMatch(result.stdout, /unsupported/u);
});
