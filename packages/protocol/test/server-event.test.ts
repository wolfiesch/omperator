import {
  hostId,
  ompServerEventFromFrame,
  pairingId,
  requestId,
  type PublicOmpServerEvent,
  type OmpServerEventFromFrame,
  type PairOkFrame,
  type WelcomeFrame,
} from "../src/index.ts";
import type { RendererServerEvent } from "../src/desktop-ipc.ts";
import { describe, expect, it } from "vite-plus/test";

function welcome(): WelcomeFrame {
  return {
    v: "omp-app/1",
    type: "welcome",
    selectedProtocol: "omp-app/1",
    hostId: hostId("shared-event-host"),
    ompVersion: "test",
    ompBuild: "test",
    appserverVersion: "test",
    appserverBuild: "test",
    epoch: "shared-event-epoch",
    grantedCapabilities: [],
    grantedFeatures: [],
    negotiatedLimits: {},
    authentication: "local",
    resumed: false,
  };
}

function pairOk(): PairOkFrame {
  return {
    v: "omp-app/1",
    type: "pair.ok",
    requestId: requestId("pair-request"),
    pairingId: pairingId("pairing-id"),
    deviceId: "device-id",
    deviceName: "Test device",
    platform: "linux",
    requestedCapabilities: [],
    grantedCapabilities: [],
    deviceToken: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    expiresAt: "2030-01-01T00:00:00.000Z",
  };
}

describe("shared server events", () => {
  it("removes wire envelope fields and freezes the normalized boundary", () => {
    const event = ompServerEventFromFrame(welcome());
    const rendererEvent: RendererServerEvent = event;
    const publicEvent: PublicOmpServerEvent = rendererEvent;

    expect(publicEvent).toMatchObject({
      kind: "welcome",
      payload: { hostId: "shared-event-host", authentication: "local" },
    });
    expect(event.payload).not.toHaveProperty("v");
    expect(event.payload).not.toHaveProperty("type");
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.payload)).toBe(true);
  });

  it("keeps the normalized welcome protocol provider-defined", () => {
    const future: OmpServerEventFromFrame<WelcomeFrame> = {
      kind: "welcome",
      payload: { ...ompServerEventFromFrame(welcome()).payload, selectedProtocol: "omp-app/2" },
    };

    expect(future.payload.selectedProtocol).toBe("omp-app/2");
  });

  it("retains privileged pair events only in the complete internal union", () => {
    const event = ompServerEventFromFrame(pairOk());

    expect(event.kind).toBe("pair.ok");
    expect(event.payload).toHaveProperty("deviceToken");
    expect(event.payload).not.toHaveProperty("v");
    expect(event.payload).not.toHaveProperty("type");
    expect(Object.isFrozen(event)).toBe(true);
  });
});
