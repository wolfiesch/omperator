// Minimal type shim for the `ws` npm package used only in tests as a fake
// collab relay/host. Real production code uses Bun's native WebSocket.
declare module "ws" {
	export class WebSocketServer {
		constructor(options: { port: number });
		once(event: "listening", listener: () => void): void;
		on(event: string, listener: (...args: any[]) => void): void;
		address(): { port: number } | null;
		close(): void;
	}
}
