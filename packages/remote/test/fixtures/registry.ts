import type { RemoteTargetRecord } from "../../src/registry.ts";

export function remoteTarget(targetId: string, address = "100.64.0.1"): RemoteTargetRecord {
  return {
    targetId,
    label: " Bunker ",
    mode: "direct",
    address,
    port: 4210,
    requestedCapabilities: ["sessions.read"],
    grantedCapabilities: [],
    status: "unknown",
  };
}

export const validRemoteTargetFixtures = [
  {
    name: "plain IPv4",
    target: remoteTarget("plain-v4", "100.64.0.1"),
    expectedAddress: "100.64.0.1",
  },
  {
    name: "plain IPv6",
    target: remoteTarget("plain-v6", "fd7a:115c:a1e0::1"),
    expectedAddress: "fd7a:115c:a1e0::1",
  },
  {
    name: "public IPv4",
    target: remoteTarget("public", "8.8.8.8"),
    expectedAddress: "8.8.8.8",
  },
  {
    name: "private LAN IPv4",
    target: remoteTarget("private", "192.168.1.2"),
    expectedAddress: "192.168.1.2",
  },
  {
    name: "public IPv6",
    target: remoteTarget("ipv6", "2001:4860:4860::8888"),
    expectedAddress: "2001:4860:4860::8888",
  },
  {
    name: "hostname",
    target: remoteTarget("hostname", "Bunker.Example.COM"),
    expectedAddress: "bunker.example.com",
  },
  {
    name: "serve with an explicit default port",
    target: {
      ...remoteTarget("serve"),
      mode: "serve",
      address: "wss://bunker.example.com:443/",
      port: 443,
    },
    expectedAddress: "wss://bunker.example.com/",
  },
] as const;

export const invalidRemoteTargetFixtures = [
  {
    name: "mDNS hostname",
    target: remoteTarget("mdns", "bunker.local"),
  },
  {
    name: "reserved local target ID",
    target: remoteTarget("local:default", "100.64.0.2"),
  },
  {
    name: "Serve query string",
    target: {
      ...remoteTarget("serve-query"),
      mode: "serve",
      address: "https://bunker.example.com/?token=secret",
      port: 443,
    },
  },
  {
    name: "Serve port mismatch",
    target: {
      ...remoteTarget("serve-port"),
      mode: "serve",
      address: "wss://bunker.example.com/",
      port: 4210,
    },
  },
] as const;

export const invalidRegistryStateFixtures: readonly unknown[] = [
  null,
  [],
  { version: 2, records: [] },
  { version: 1, records: "not-an-array" },
  { version: 1, records: [], extra: true },
  { version: 1, records: [null] },
  { version: 1, records: [{ ...remoteTarget("extra"), extra: true }] },
  Object.assign(Object.create({ inherited: true }) as object, {
    version: 1,
    records: [],
  }),
];

export const invalidCredentialStateFixtures: readonly unknown[] = [
  null,
  [],
  { version: 2, ciphertexts: {} },
  { version: 1, ciphertexts: [] },
  { version: 1, ciphertexts: { remote: "not base64!" } },
  { version: 1, ciphertexts: { "bad ref": "YWJj" } },
  { version: 1, ciphertexts: {}, extra: true },
  {
    version: 1,
    ciphertexts: Object.assign(Object.create({ inherited: "YWJj" }) as object, {}),
  },
];
