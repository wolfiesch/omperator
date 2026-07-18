import { describe, expect, it } from "vitest";
import { redactRemoteDiagnostics } from "../src/remote-runtime/index.ts";

describe("remote runtime diagnostics", () => {
  it("redacts secrets recursively", () => {
    expect(
      redactRemoteDiagnostics({
        token: "raw-device-token",
        nested: [{ ciphertext: "secret" }],
      }),
    ).toEqual({
      token: "[redacted]",
      nested: [{ ciphertext: "[redacted]" }],
    });
  });
});
