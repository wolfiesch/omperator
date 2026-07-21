import type { ServerFrame } from "@t4-code/host-wire";

/** Server frames the upstream decoder can actually emit. */
export type OmpServerFrame = Exclude<ServerFrame, { type: "pair.start" }>;

const OMP_SERVER_EVENT_KIND_MEMBERS = {
  welcome: true,
  sessions: true,
  snapshot: true,
  entry: true,
  event: true,
  agent: true,
  terminal: true,
  files: true,
  review: true,
  audit: true,
  "pair.ok": true,
  "pair.error": true,
  confirmation: true,
  response: true,
  gap: true,
  error: true,
  pong: true,
  bye: true,
  "host.watch": true,
  "session.watch": true,
  "session.state": true,
  "session.delta": true,
  "workspace.state": true,
  lease: true,
  "prompt.lease": true,
  "agent.state": true,
  "agent.lifecycle": true,
  "agent.progress": true,
  "agent.event": true,
  "agent.transcript": true,
  "terminal.output": true,
  "terminal.exit": true,
  "files.list": true,
  "files.read": true,
  "files.write": true,
  "files.patch": true,
  "files.diff": true,
  "audit.tail": true,
  "audit.event": true,
  catalog: true,
  settings: true,
  "preview.launch": true,
  "preview.state": true,
  "preview.navigation": true,
  "preview.capture": true,
  "preview.error": true,
} as const satisfies Record<OmpServerFrame["type"], true>;

/** Exhaustive normalized event vocabulary for the pinned OMP server contract. */
export const OMP_SERVER_EVENT_KINDS: readonly OmpServerFrame["type"][] = Object.freeze(
  Object.keys(OMP_SERVER_EVENT_KIND_MEMBERS) as OmpServerFrame["type"][],
);

type KnownFields<Value> = {
  [Key in keyof Value as string extends Key
    ? never
    : number extends Key
      ? never
      : symbol extends Key
        ? never
        : Key]: Value[Key];
};

type PreservedIndex<Value> = string extends keyof Value
  ? Readonly<Record<string, unknown>>
  : object;

type NormalizeProtocolFields<Frame extends OmpServerFrame, Payload> =
  Frame extends { type: "welcome" }
    ? Omit<Payload, "selectedProtocol"> & { readonly selectedProtocol: string }
    : Payload;

export type OmpServerEventPayload<Frame extends OmpServerFrame> = Readonly<
  NormalizeProtocolFields<
    Frame,
    Omit<KnownFields<Frame>, "v" | "type"> & PreservedIndex<Frame>
  >
>;

export type OmpServerEventFromFrame<Frame extends OmpServerFrame> =
  Frame extends OmpServerFrame
    ? Readonly<{
        kind: Frame["type"];
        payload: OmpServerEventPayload<Frame>;
      }>
    : never;

/** Stable, version-free event union shared by protocol providers and applications. */
export type OmpServerEvent = OmpServerEventFromFrame<OmpServerFrame>;

/** Pairing credentials never cross application-facing event boundaries. */
export type PublicOmpServerEvent = Exclude<OmpServerEvent, { kind: "pair.ok" }>;

export function ompServerEventFromFrame<Frame extends OmpServerFrame>(
  frame: Frame,
): OmpServerEventFromFrame<Frame> {
  const { v: _version, type, ...payload } = frame;
  return Object.freeze({
    kind: type,
    payload: Object.freeze(payload),
  }) as OmpServerEventFromFrame<Frame>;
}
