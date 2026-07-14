import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mobileRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const webDist = resolve(mobileRoot, "../web/dist");
const mobileDist = resolve(mobileRoot, "dist");
const sourceIndex = resolve(webDist, "index.html");
const MOBILE_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "connect-src 'self' wss://*.ts.net:*",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "form-action 'none'",
].join("; ");

let indexHtml;
try {
  indexHtml = await readFile(sourceIndex, "utf8");
} catch {
  throw new Error("apps/web/dist is missing; run `pnpm build:web` before syncing the mobile shell");
}

if (!indexHtml.includes('<div id="root"></div>')) {
  throw new Error("apps/web/dist/index.html is not a T4 Code web build");
}
if (indexHtml.includes('http-equiv="Content-Security-Policy"')) {
  throw new Error("apps/web/dist/index.html already contains a content security policy");
}

const mobileIndexHtml = indexHtml.replace(
  "  </head>",
  `    <meta http-equiv="Content-Security-Policy" content="${MOBILE_CONTENT_SECURITY_POLICY}" />\n  </head>`,
);
if (mobileIndexHtml === indexHtml) {
  throw new Error("apps/web/dist/index.html is missing its closing head element");
}

await rm(mobileDist, { force: true, recursive: true });
await mkdir(mobileDist, { recursive: true });
await cp(webDist, mobileDist, { recursive: true });
await writeFile(resolve(mobileDist, "index.html"), mobileIndexHtml, "utf8");

const buildMetadata = {
  appId: "com.lycaonsolutions.t4code",
  bundledWebApp: true,
  nativeOrigin: "https://localhost",
};
await writeFile(resolve(mobileDist, "mobile-build.json"), `${JSON.stringify(buildMetadata, null, 2)}\n`, "utf8");

console.log(`Prepared bundled T4 web assets in ${mobileDist}`);
