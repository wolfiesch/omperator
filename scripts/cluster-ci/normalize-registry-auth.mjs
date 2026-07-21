import { chmod, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HARBOR_REGISTRY_ALIASES = Object.freeze([
  "harbor.tailb18de3.ts.net",
  "https://harbor.tailb18de3.ts.net",
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeRegistryAuth(config) {
  if (!isObject(config) || !isObject(config.auths)) {
    throw new Error("Harbor Docker config must contain an auths object");
  }

  const source = HARBOR_REGISTRY_ALIASES.map((host) => config.auths[host]).find(
    (entry) => isObject(entry) && typeof entry.auth === "string" && /^[A-Za-z0-9+/]+={0,2}$/u.test(entry.auth),
  );
  if (!source) {
    throw new Error("Harbor Docker config has no bounded registry authentication entry");
  }

  return {
    auths: Object.fromEntries(HARBOR_REGISTRY_ALIASES.map((host) => [host, { auth: source.auth }])),
  };
}

export async function normalizeRegistryAuthFile(path) {
  const config = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, `${JSON.stringify(normalizeRegistryAuth(config))}\n`, { mode: 0o444 });
  await chmod(path, 0o444);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (!path) throw new Error("Docker config path is required");
  await normalizeRegistryAuthFile(path);
}
