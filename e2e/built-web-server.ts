import { access, readFile, stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const WEB_DIST = resolve(REPO_ROOT, "apps/web/dist");

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

interface BuiltWebBackend {
  readonly wsUrl: string;
  readonly label: string;
  readonly clusterOperatorEnabled?: true;
}

const DEFAULT_BACKEND: BuiltWebBackend = {
  wsUrl: "ws://127.0.0.1:1/v1/ws",
  label: "PWA fixture backend",
};

function injectBackend(html: string, backend: BuiltWebBackend): string {
  const payload = JSON.stringify(backend);
  const tag = `<script id="t4-backend" type="application/json">${payload}</script>`;
  if (!html.includes("</head>")) throw new Error("web dist index is missing </head>");
  return html.replace("</head>", `${tag}</head>`);
}

/** Serves the built client. `/fixture` keeps the deterministic browser fixture backend. */
export class BuiltWebServer {
  private readonly server: Server;
  private port = 0;

  constructor(private readonly backend: BuiltWebBackend = DEFAULT_BACKEND) {
    this.server = createServer((request, response) => {
      void this.handle(request.url ?? "/", request.method ?? "GET")
        .then(({ body, contentType, status }) => {
          response.writeHead(status, {
            "cache-control": "no-store",
            "content-type": contentType,
            "x-content-type-options": "nosniff",
          });
          response.end(request.method === "HEAD" ? undefined : body);
        })
        .catch((error: unknown) => {
          response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
          response.end(error instanceof Error ? error.message : "fixture web server failed");
        });
    });
  }

  get url(): string {
    if (this.port === 0) throw new Error("fixture web server is not running");
    return `http://127.0.0.1:${this.port}/`;
  }

  async start(): Promise<void> {
    await access(resolve(WEB_DIST, "index.html"));
    await new Promise<void>((resolveStart, reject) => {
      const onError = (error: Error) => {
        this.server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off("error", onError);
        this.port = (this.server.address() as AddressInfo).port;
        resolveStart();
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(0, "127.0.0.1");
    });
  }

  async stop(): Promise<void> {
    if (this.port === 0) return;
    await new Promise<void>((resolveStop) => this.server.close(() => resolveStop()));
    this.port = 0;
  }

  private async handle(
    rawUrl: string,
    method: string,
  ): Promise<{ body: Buffer | string; contentType: string; status: number }> {
    if (method !== "GET" && method !== "HEAD") {
      return { body: "method not allowed", contentType: "text/plain; charset=utf-8", status: 405 };
    }
    const pathname = decodeURIComponent(new URL(rawUrl, "http://fixture.invalid").pathname);
    if (pathname === "/fixture") {
      return {
        body: await readFile(resolve(WEB_DIST, "index.html"), "utf8"),
        contentType: MIME_TYPES[".html"]!,
        status: 200,
      };
    }
    if (pathname === "/" || pathname === "/index.html") {
      return {
        body: injectBackend(await readFile(resolve(WEB_DIST, "index.html"), "utf8"), this.backend),
        contentType: MIME_TYPES[".html"]!,
        status: 200,
      };
    }

    const candidate = resolve(WEB_DIST, `.${pathname}`);
    if (!candidate.startsWith(`${WEB_DIST}${sep}`)) {
      return { body: "not found", contentType: "text/plain; charset=utf-8", status: 404 };
    }
    try {
      if (!(await stat(candidate)).isFile()) throw new Error("not a file");
      return {
        body: await readFile(candidate),
        contentType: MIME_TYPES[extname(candidate)] ?? "application/octet-stream",
        status: 200,
      };
    } catch {
      return { body: "not found", contentType: "text/plain; charset=utf-8", status: 404 };
    }
  }
}
