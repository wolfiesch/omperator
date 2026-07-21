import { expect, test } from "bun:test";
import { CI_TRIGGER_CAPABILITY, CLUSTER_OPERATOR_FEATURE } from "@t4-code/host-wire";
import { appserverSupportedCapabilities, appserverSupportedFeatures } from "../src/server.ts";

/** Local and ordinary paired hosts know the additive wire names but stay behaviorally unchanged. */
test("ordinary appservers keep the cluster operator and CI mutation default-off", () => {
	expect(appserverSupportedFeatures({})).not.toContain(CLUSTER_OPERATOR_FEATURE);
	expect(appserverSupportedFeatures({}, true)).not.toContain(CLUSTER_OPERATOR_FEATURE);
	expect(appserverSupportedCapabilities({})).not.toContain(CI_TRIGGER_CAPABILITY);

	// Merely naming the feature/capability in an override cannot turn on an
	// implementation that has no explicit cluster authority.
	expect(appserverSupportedFeatures({ supportedFeatures: [CLUSTER_OPERATOR_FEATURE] })).not.toContain(
		CLUSTER_OPERATOR_FEATURE,
	);
});
