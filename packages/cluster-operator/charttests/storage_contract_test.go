package charttests

import (
	"strings"
	"testing"
)

func TestClusterHostRendersSeparatedStorageAndSnapshotSelection(t *testing.T) {
	output := helmTemplate(t, enabledValues()...)
	host := documentContainingKind(t, output, "T4ClusterHost", "name: \"t4-cluster\"")
	assertContains(t, host,
		"storageClassName: \"portable-rwx\"",
		"runtimeStateStorageProfile:",
		"storageClassName: \"portable-runtime-rwop\"",
		"size: \"10Gi\"",
		"accessMode: \"ReadWriteOncePod\"",
		"volumeSnapshotClassName: \"portable-snapshots\"",
	)
}

func TestStorageSelectionFailsClosedWhenEnabled(t *testing.T) {
	for _, key := range []string{"storage.runtimeStateStorageClass=", "storage.volumeSnapshotClass="} {
		values := append(enabledValues(), "--set-string", key)
		helmTemplateMustFail(t, values...)
	}
}

func TestRenderedControlPlaneHasNoWorkspaceAuthorityMount(t *testing.T) {
	output := helmTemplate(t, enabledValues()...)
	for _, forbidden := range []string{"/workspace/.omp", "/workspace/.cmux", "/workspace/omp", "/workspace/cmux", "/workspace/browser"} {
		if strings.Contains(output, forbidden) {
			t.Fatalf("rendered control plane contains authority path under workspace: %s", forbidden)
		}
	}
}
func TestStorageRecoveryCRDsExposeBoundedContracts(t *testing.T) {
	root := repoRoot(t)
	host := mustRead(t, root+"/deploy/charts/t4-cluster/crds/t4clusterhosts.cluster.t4.dev.yaml")
	session := mustRead(t, root+"/deploy/charts/t4-cluster/crds/t4sessions.cluster.t4.dev.yaml")
	workspace := mustRead(t, root+"/deploy/charts/t4-cluster/crds/t4workspaces.cluster.t4.dev.yaml")
	assertContains(t, host,
		"accessMode:",
		"enum: [ReadWriteOncePod, ReadWriteOnce]",
		"storageCapabilities:",
		"runtimeStateReattach:",
		"snapshotDataSource:",
	)
	assertContains(t, session,
		"checkpoint:",
		"enum: [Quiesced, CrashConsistent]",
		"durableAcks:",
		"workspaceSnapshotRef:",
		"runtimeStateSnapshotRef:",
		"allowCrashConsistentRestore:",
		"restorePublicIdPolicy:",
	)
	assertContains(t, workspace,
		"restoreSnapshotRef:",
		"allowCrashConsistentRestore:",
		"restorePublicIdPolicy:",
	)
}

