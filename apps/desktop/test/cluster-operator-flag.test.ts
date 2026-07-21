import { describe, expect, it } from "vitest";
import {
  DESKTOP_CLUSTER_OPERATOR_SWITCH,
  desktopClusterOperatorEnabled,
} from "../src/cluster-operator-flag.ts";

describe("desktop cluster operator feature switch", () => {
  it("is default-off and accepts only the exact explicit switch", () => {
    expect(desktopClusterOperatorEnabled([])).toBe(false);
    expect(desktopClusterOperatorEnabled([`${DESKTOP_CLUSTER_OPERATOR_SWITCH}=true`])).toBe(false);
    expect(desktopClusterOperatorEnabled([`prefix${DESKTOP_CLUSTER_OPERATOR_SWITCH}`])).toBe(false);
    expect(desktopClusterOperatorEnabled([DESKTOP_CLUSTER_OPERATOR_SWITCH])).toBe(true);
  });
});
