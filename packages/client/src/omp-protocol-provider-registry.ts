import { ompAppV1ProtocolProvider } from "./omp-app-v1-protocol-provider.ts";
import type { OmpProtocolProvider } from "./omp-protocol-provider.ts";

function registryKey(value: string, label: string): string {
  const hasControlCharacter = Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint <= 31 || codePoint === 127);
  });
  if (value.length === 0 || value.length > 128 || hasControlCharacter) {
    throw new Error(`invalid protocol provider ${label}`);
  }
  return value;
}

/** Immutable lookup table for concrete protocol adapters. */
export class OmpProtocolProviderRegistry {
  readonly providers: readonly OmpProtocolProvider[];
  readonly defaultProviderId: string;
  private readonly byId: ReadonlyMap<string, OmpProtocolProvider>;
  private readonly byVersion: ReadonlyMap<string, OmpProtocolProvider>;

  constructor(providers: readonly OmpProtocolProvider[], defaultProviderId = providers[0]?.id) {
    if (providers.length === 0 || defaultProviderId === undefined) {
      throw new Error("at least one protocol provider is required");
    }
    const byId = new Map<string, OmpProtocolProvider>();
    const byVersion = new Map<string, OmpProtocolProvider>();
    for (const provider of providers) {
      const id = registryKey(provider.id, "id");
      const version = registryKey(provider.protocolVersion, "version");
      if (byId.has(id)) throw new Error(`duplicate protocol provider id: ${id}`);
      if (byVersion.has(version)) throw new Error(`duplicate protocol version: ${version}`);
      byId.set(id, provider);
      byVersion.set(version, provider);
    }
    const selectedDefault = registryKey(defaultProviderId, "default id");
    if (!byId.has(selectedDefault)) throw new Error(`unknown default protocol provider: ${selectedDefault}`);
    this.providers = Object.freeze([...providers]);
    this.defaultProviderId = selectedDefault;
    this.byId = byId;
    this.byVersion = byVersion;
    Object.freeze(this);
  }

  getById(id: string): OmpProtocolProvider | undefined {
    return this.byId.get(id);
  }

  getByProtocolVersion(version: string): OmpProtocolProvider | undefined {
    return this.byVersion.get(version);
  }

  requireById(id = this.defaultProviderId): OmpProtocolProvider {
    const provider = this.getById(id);
    if (provider === undefined) throw new Error(`unknown protocol provider: ${id}`);
    return provider;
  }
}

export const defaultOmpProtocolProviderRegistry = new OmpProtocolProviderRegistry([
  ompAppV1ProtocolProvider,
]);

export function resolveOmpProtocolProvider(options: {
  readonly protocolProvider?: OmpProtocolProvider;
  readonly protocolProviderId?: string;
  readonly protocolProviderRegistry?: OmpProtocolProviderRegistry;
}): OmpProtocolProvider {
  if (options.protocolProvider !== undefined) {
    if (options.protocolProviderId !== undefined || options.protocolProviderRegistry !== undefined) {
      throw new Error("direct protocol provider cannot be combined with registry selection");
    }
    return options.protocolProvider;
  }
  const registry = options.protocolProviderRegistry ?? defaultOmpProtocolProviderRegistry;
  return registry.requireById(options.protocolProviderId);
}
