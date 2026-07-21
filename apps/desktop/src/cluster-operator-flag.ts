export const DESKTOP_CLUSTER_OPERATOR_SWITCH = "--t4-cluster-operator";

export function desktopClusterOperatorEnabled(
  arguments_: readonly string[] = process.argv,
): boolean {
  return arguments_.includes(DESKTOP_CLUSTER_OPERATOR_SWITCH);
}
