import type { SessionId } from "@t4-code/host-wire";
import type { RemoteConnection } from "./remote/types.ts";
import type { ConnectionTransport, RemoteHelloDecision } from "./types.ts";

/**
 * Owns connection-scoped state independently from command and session state.
 * LocalAppserver coordinates protocol behavior, while this registry defines
 * the lifecycle boundary for every transport-indexed collection.
 */
export class AppserverConnectionRegistry<LocalSocket> {
	readonly clients = new Set<ConnectionTransport>();
	readonly hello = new Set<ConnectionTransport>();
	readonly capabilities = new Map<ConnectionTransport, Set<string>>();
	readonly features = new Map<ConnectionTransport, Set<string>>();
	readonly attached = new Map<ConnectionTransport, Set<SessionId>>();
	readonly abortControllers = new Map<ConnectionTransport, Set<AbortController>>();
	readonly outboundTails = new Map<ConnectionTransport, Promise<void>>();
	readonly localTransports = new Map<LocalSocket, ConnectionTransport>();
	readonly remoteTransports = new Map<string, ConnectionTransport>();
	readonly remoteConnections = new Map<ConnectionTransport, RemoteConnection>();
	readonly remoteDecisions = new Map<ConnectionTransport, RemoteHelloDecision>();

	register(transport: ConnectionTransport): void {
		this.clients.add(transport);
		this.capabilities.set(transport, new Set());
		this.features.set(transport, new Set());
		this.attached.set(transport, new Set());
		this.abortControllers.set(transport, new Set());
	}

	registerLocal(socket: LocalSocket, transport: ConnectionTransport): void {
		this.localTransports.set(socket, transport);
		this.register(transport);
	}

	registerRemote(connection: RemoteConnection, transport: ConnectionTransport): void {
		this.remoteConnections.set(transport, connection);
		this.remoteTransports.set(transport.connectionId, transport);
		this.register(transport);
	}

	forget(transport: ConnectionTransport): void {
		this.clients.delete(transport);
		this.hello.delete(transport);
		this.capabilities.delete(transport);
		this.features.delete(transport);
		this.attached.delete(transport);
		this.abortControllers.delete(transport);
		this.remoteDecisions.delete(transport);
		this.remoteConnections.delete(transport);
		this.remoteTransports.delete(transport.connectionId);
		for (const [socket, candidate] of this.localTransports)
			if (candidate === transport) this.localTransports.delete(socket);
	}
}
