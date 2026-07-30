import { createConnection, type Socket } from "node:net";
import type { CmuxRuntimeHandle } from "@t4-code/cmux-runtime";
import type { Generation, RuntimeId } from "@t4-code/portable-core";
import type { RouteDescriptor } from "@t4-code/portable-driver";

export interface ResolvedCmuxRoute { readonly runtimeId: RuntimeId; readonly runtimeGeneration: Generation; readonly route: RouteDescriptor }
export interface DuplexByteStream {
  readonly readable: AsyncIterable<Uint8Array>;
  write(chunk: Uint8Array): Promise<void>;
  end(): Promise<void>;
  close(cause?: unknown): Promise<void>;
}
export interface CmuxRouteOpener { open(route: ResolvedCmuxRoute, signal?: AbortSignal): Promise<DuplexByteStream> }
export interface CmuxRuntimeHandleRegistry { get(runtimeId: RuntimeId, generation: Generation): CmuxRuntimeHandle | undefined }

function socketStream(socket: Socket): DuplexByteStream {
  return {
    readable: socket as AsyncIterable<Uint8Array>,
    write: chunk => new Promise<void>((resolve, reject) => socket.write(chunk, error => error ? reject(error) : resolve())),
    end: () => new Promise<void>((resolve, reject) => { socket.once("error", reject); socket.end(() => { socket.off("error", reject); resolve(); }); }),
    close: async cause => { socket.destroy(cause instanceof Error ? cause : undefined); },
  };
}
/** Matches only server-owned runtime id/generation. The opaque route reference is never interpreted. */
export class LocalCmuxRouteOpener implements CmuxRouteOpener {
  readonly #handles: CmuxRuntimeHandleRegistry;
  constructor(handles: CmuxRuntimeHandleRegistry) { this.#handles = handles; }
  async open(resolved: ResolvedCmuxRoute, signal?: AbortSignal): Promise<DuplexByteStream> {
    if (resolved.route.kind !== "cmux-v10") throw new TypeError("route kind is not cmux-v10");
    const handle = this.#handles.get(resolved.runtimeId, resolved.runtimeGeneration);
    if (!handle || handle.runtimeId !== resolved.runtimeId || handle.generation !== resolved.runtimeGeneration) throw new Error("live cmux runtime generation is unavailable");
    const socket = createConnection({ path: handle.socketPath, signal });
    await new Promise<void>((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    return socketStream(socket);
  }
}
