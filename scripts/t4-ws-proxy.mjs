// Frame-logging WS proxy: app → proxy:18787 → host:8787. Logs every frame
// both directions (truncated), forwarding bytes untouched.
import WebSocket, { WebSocketServer } from "ws";

const upstreamUrl = "ws://100.98.34.4:8787/v1/ws";
const wss = new WebSocketServer({ port: 18787, path: "/v1/ws" });
console.log("proxy on 18787 →", upstreamUrl);

wss.on("connection", (client) => {
  const upstream = new WebSocket(upstreamUrl);
  const tag = (dir) => (data) => {
    const text = data.toString();
    console.log(dir, text.length > 500 ? text.slice(0, 500) + "…" : text);
  };
  client.on("message", (data) => { tag("C→H")(data); if (upstream.readyState === 1) upstream.send(data); else upstream.once("open", () => upstream.send(data)); });
  upstream.on("message", tag("H→C"));
  client.on("close", () => upstream.close());
  upstream.on("close", () => client.close());
  upstream.on("error", (e) => console.log("upstream error:", e.message));
});
