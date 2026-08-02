#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
const hostPath = join(repoRoot, "packages", "host-daemon", "dist", "t4-host");
const binary = await readFile(hostPath);

if (binary.includes(Buffer.from(repoRoot, "utf8"))) {
  throw new Error("compiled t4-host contains an absolute build-worktree path");
}

console.log("compiled t4-host is free of absolute build-worktree paths");
