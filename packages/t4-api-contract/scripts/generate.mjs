import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import openapiTS, { astToString } from "openapi-typescript";

const contractRoot = fileURLToPath(new URL("..", import.meta.url));
const schemaUrl = new URL("../openapi.json", import.meta.url);
const target = resolve(contractRoot, "../t4-api-client/src/generated/schema.ts");
const mode = process.argv[2];
if (!new Set(["--write", "--check", "--ci-artifact"]).has(mode)) {
  throw new Error("usage: node scripts/generate.mjs --write|--check|--ci-artifact");
}

const generated = `${astToString(await openapiTS(schemaUrl, { alphabetize: true, defaultNonNullable: false })).trimEnd()}\n`;
const digest = createHash("sha256").update(generated).digest("hex");

if (mode === "--write") {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, generated);
  await chmod(target, 0o644);
  console.log(`generated ${target} sha256:${digest}`);
  process.exit(0);
}

if (mode === "--ci-artifact") {
  const artifact = resolve(contractRoot, "../../artifacts/t4-api/generated/schema.ts");
  await mkdir(dirname(artifact), { recursive: true });
  await writeFile(artifact, generated);
  await chmod(artifact, 0o644);
  console.log(`T4_API_GENERATED_SHA256=${digest}`);
  console.log(`T4_API_GENERATED_BASE64_BEGIN\n${Buffer.from(generated).toString("base64")}\nT4_API_GENERATED_BASE64_END`);
}

let checkedIn;
try {
  checkedIn = await readFile(target, "utf8");
} catch (error) {
  if (mode === "--ci-artifact") throw new Error(`generated client is absent; recover the CI artifact at artifacts/t4-api/generated/schema.ts (sha256:${digest})`, { cause: error });
  throw error;
}
if (checkedIn !== generated) {
  throw new Error(`generated client drift: expected sha256:${digest}; regenerate only with the authorized CI artifact`);
}
if (((await stat(target)).mode & 0o111) !== 0) {
  throw new Error("generated client mode drift: schema.ts must not be executable");
}
console.log(`generated client is deterministic (sha256:${digest})`);
