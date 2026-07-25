import { extname } from "node:path";

export function pnpmProcessInvocation(args, entrypoint = process.env.npm_execpath) {
  if (entrypoint === undefined || entrypoint.length === 0) {
    return { command: "pnpm", args };
  }
  const extension = extname(entrypoint).toLowerCase();
  return extension === ".js" || extension === ".cjs" || extension === ".mjs"
    ? { command: process.execPath, args: [entrypoint, ...args] }
    : { command: entrypoint, args };
}
