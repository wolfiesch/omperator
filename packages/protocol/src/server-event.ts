import type { ServerFrame } from "@oh-my-pi/app-wire";

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

type NormalizeProtocolFields<Frame extends ServerFrame, Payload> =
  Frame extends { type: "welcome" }
    ? Omit<Payload, "selectedProtocol"> & { readonly selectedProtocol: string }
    : Payload;

export type OmpServerEventPayload<Frame extends ServerFrame> = Readonly<
  NormalizeProtocolFields<
    Frame,
    Omit<KnownFields<Frame>, "v" | "type"> & PreservedIndex<Frame>
  >
>;

export type OmpServerEventFromFrame<Frame extends ServerFrame> =
  Frame extends ServerFrame
    ? Readonly<{
        kind: Frame["type"];
        payload: OmpServerEventPayload<Frame>;
      }>
    : never;

/** Stable, version-free event union shared by protocol providers and applications. */
export type OmpServerEvent = OmpServerEventFromFrame<ServerFrame>;

/** Pairing credentials never cross application-facing event boundaries. */
export type PublicOmpServerEvent = Exclude<OmpServerEvent, { kind: "pair.ok" }>;

export function ompServerEventFromFrame<Frame extends ServerFrame>(
  frame: Frame,
): OmpServerEventFromFrame<Frame> {
  const { v: _version, type, ...payload } = frame;
  return Object.freeze({
    kind: type,
    payload: Object.freeze(payload),
  }) as OmpServerEventFromFrame<Frame>;
}
