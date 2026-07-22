export const pairLinkFixtures = Object.freeze({
  valid: [
    ["t4-code://pair/bunker/123456", { hostHint: "bunker", code: "123456", issuedAt: 1234 }],
    ["t4-code://pair/host-a.example/654321", { hostHint: "host-a.example", code: "654321", issuedAt: 1234 }],
  ] as const,
  invalid: [
    "not a URL",
    "https://pair/host-a/123456",
    "t4-code://other/host-a/123456",
    "t4-code://pair/host-a/12345",
    "t4-code://pair/host-a/123456/extra",
    "t4-code://user:pass@pair/host-a/123456",
    "t4-code://pair/host-a/123456?token=secret",
    "t4-code://pair/host-a/123456#secret",
    "t4-code://pair/host%00a/123456",
  ] as const,
});

export const androidUpdateFixtures = Object.freeze({
  valid: [
    {
      currentVersion: "0.1.22",
      phase: "idle",
      revision: 0,
    },
    {
      currentVersion: "0.1.22",
      latestVersion: "0.1.31",
      checkedAt: 1_721_234_567_890,
      phase: "available",
      revision: 7,
      message: "Update ready.",
    },
    {
      currentVersion: "0.1.22",
      latestVersion: "0.1.31",
      phase: "installer",
      revision: 8,
      message: "Installer opened.\nReview Android's prompt.",
    },
  ] as const,
  invalid: [
    null,
    { currentVersion: "latest", phase: "idle", revision: 0 },
    { currentVersion: "0.1.22-beta.1", phase: "idle", revision: 0 },
    { currentVersion: "0.1.22", phase: "installing", revision: 1 },
    { currentVersion: "0.1.22", phase: "idle", revision: -1 },
    { currentVersion: "0.1.22", phase: "idle", revision: 1, checkedAt: -1 },
    { currentVersion: "0.1.22", phase: "idle", revision: 1, downloadUrl: "https://attacker.invalid/app.apk" },
  ] as const,
});
