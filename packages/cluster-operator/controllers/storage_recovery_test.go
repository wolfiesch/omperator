package controllers

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	storagev1 "k8s.io/api/storage/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	clusterv1alpha1 "github.com/wolfiesch/omperator/packages/cluster-operator/api/v1alpha1"
)

func storageTestScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	scheme := runtime.NewScheme()
	for _, add := range []func(*runtime.Scheme) error{corev1.AddToScheme, storagev1.AddToScheme, clusterv1alpha1.AddToScheme} {
		if err := add(scheme); err != nil {
			t.Fatal(err)
		}
	}
	return scheme
}

func TestObserveStorageCapabilitiesRequiresConformanceMarkers(t *testing.T) {
	expand := true
	workspaceClass := &storagev1.StorageClass{
		ObjectMeta: metav1.ObjectMeta{Name: "rwx", Annotations: map[string]string{clusterv1alpha1.RWXStorageClassAnnotation: "ReadWriteMany"}},
		Provisioner: "fixture.csi.t4.dev",
		AllowVolumeExpansion: &expand,
	}
	runtimeClass := &storagev1.StorageClass{
		ObjectMeta: metav1.ObjectMeta{Name: "runtime"}, Provisioner: "fixture.csi.t4.dev", AllowVolumeExpansion: &expand,
	}
	snapshotClass := volumeSnapshotClass("snapshots", "fixture.csi.t4.dev", nil)
	reader := fake.NewClientBuilder().WithScheme(storageTestScheme(t)).WithObjects(workspaceClass, runtimeClass, snapshotClass).Build()
	host := storageHost()

	observed, err := ObserveStorageCapabilities(context.Background(), reader, host, metav1.Unix(100, 0))
	if err != nil {
		t.Fatal(err)
	}
	if observed.WorkspaceReadWriteMany.State != clusterv1alpha1.StorageCapabilityUnknown || observed.RuntimeStateReattach.State != clusterv1alpha1.StorageCapabilityUnknown || observed.VolumeSnapshots.State != clusterv1alpha1.StorageCapabilityUnknown {
		t.Fatalf("configuration was incorrectly treated as conformance proof: %#v", observed)
	}
	if observed.OnlineExpansion.State != clusterv1alpha1.StorageCapabilitySupported {
		t.Fatalf("online expansion = %#v", observed.OnlineExpansion)
	}

	workspaceClass.Annotations[StorageConformanceRWXAnnotation] = "passed"
	runtimeClass.Annotations = map[string]string{StorageConformanceReattachAnnotation: "passed"}
	snapshotClass.SetAnnotations(map[string]string{StorageConformanceSnapshotAnnotation: "passed"})
	reader = fake.NewClientBuilder().WithScheme(storageTestScheme(t)).WithObjects(workspaceClass, runtimeClass, snapshotClass).Build()
	observed, err = ObserveStorageCapabilities(context.Background(), reader, host, metav1.Unix(200, 0))
	if err != nil {
		t.Fatal(err)
	}
	for name, capability := range map[string]clusterv1alpha1.StorageCapabilityObservation{
		"workspace": observed.WorkspaceReadWriteMany,
		"reattach": observed.RuntimeStateReattach,
		"snapshots": observed.VolumeSnapshots,
		"data source": observed.SnapshotDataSource,
	} {
		if capability.State != clusterv1alpha1.StorageCapabilitySupported {
			t.Fatalf("%s = %#v", name, capability)
		}
	}
}

func TestStorageCapabilitiesPermitRuntimeFailsClosed(t *testing.T) {
	host := storageHost()
	if err := StorageCapabilitiesPermitRuntime(host); err == nil {
		t.Fatal("missing observations unexpectedly allowed runtime")
	}
	host.Status.StorageCapabilities = &clusterv1alpha1.StorageCapabilities{
		WorkspaceReadWriteMany: clusterv1alpha1.StorageCapabilityObservation{State: clusterv1alpha1.StorageCapabilitySupported},
		RuntimeStateReattach: clusterv1alpha1.StorageCapabilityObservation{State: clusterv1alpha1.StorageCapabilityUnknown},
		WorkspaceStorageClassName: "rwx",
		RuntimeStateStorageClassName: "runtime",
	}
	if err := StorageCapabilitiesPermitRuntime(host); err == nil {
		t.Fatal("unknown reattach capability unexpectedly allowed runtime")
	}
	host.Status.StorageCapabilities.RuntimeStateReattach.State = clusterv1alpha1.StorageCapabilitySupported
	if err := StorageCapabilitiesPermitRuntime(host); err != nil {
		t.Fatal(err)
	}
	host.Status.StorageCapabilities.RuntimeStateStorageClassName = "stale-runtime"
	if err := StorageCapabilitiesPermitRuntime(host); err == nil {
		t.Fatal("stale capability observation unexpectedly allowed runtime")
	}
	host.Status.StorageCapabilities.RuntimeStateStorageClassName = "runtime"
}

func TestCheckpointDurableAcksAreGenerationBound(t *testing.T) {
	session := &clusterv1alpha1.T4Session{
		Spec: clusterv1alpha1.T4SessionSpec{BrowserPolicy: clusterv1alpha1.BrowserPolicyAllowed},
		Status: clusterv1alpha1.T4SessionStatus{RuntimeGeneration: "gen_current"},
	}
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{
		Labels: map[string]string{"cluster.t4.dev/runtime-generation": "gen_current"},
		Annotations: map[string]string{
			CheckpointOMPAckAnnotation: "gen_current", CheckpointCmuxAckAnnotation: "gen_current", CheckpointBrowserAckAnnotation: "gen_old",
		},
	}}
	if _, err := CheckpointDurableAcks(session, pod); err == nil {
		t.Fatal("stale browser acknowledgement unexpectedly accepted")
	}
	pod.Annotations[CheckpointBrowserAckAnnotation] = "gen_current"
	acks, err := CheckpointDurableAcks(session, pod)
	if err != nil || !acks.OMP || !acks.Cmux || !acks.Browser {
		t.Fatalf("acks = %#v, err = %v", acks, err)
	}
}

func TestValidateRestoreSnapshotChecksReadinessSourceAndStorage(t *testing.T) {
	pvc := &corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Name: "runtime-pvc", Namespace: "team"}, Spec: corev1.PersistentVolumeClaimSpec{StorageClassName: pointer("runtime")}}
	snapshot := NewVolumeSnapshot("team", "runtime-snapshot", "snapshots", pvc.Name, SnapshotSourceRuntimeState, string(clusterv1alpha1.SnapshotConsistencyQuiesced), "gen_source", nil)
	if err := unstructuredSet(snapshot, map[string]any{"readyToUse": true}, "status"); err != nil {
		t.Fatal(err)
	}
	runtimeClass := &storagev1.StorageClass{ObjectMeta: metav1.ObjectMeta{Name: "runtime"}, Provisioner: "fixture.csi.t4.dev"}
	snapshotClass := volumeSnapshotClass("snapshots", "fixture.csi.t4.dev", nil)
	reader := fake.NewClientBuilder().WithScheme(storageTestScheme(t)).WithObjects(pvc, snapshot, runtimeClass, snapshotClass).Build()
	ref := &clusterv1alpha1.VolumeSnapshotReference{Name: snapshot.GetName()}
	if _, err := ValidateRestoreSnapshot(context.Background(), reader, "team", ref, SnapshotSourceRuntimeState, "runtime", "snapshots", false); err != nil {
		t.Fatal(err)
	}
	snapshot.Object["status"] = map[string]any{"readyToUse": false}
	reader = fake.NewClientBuilder().WithScheme(storageTestScheme(t)).WithObjects(pvc, snapshot, runtimeClass, snapshotClass).Build()
	if _, err := ValidateRestoreSnapshot(context.Background(), reader, "team", ref, SnapshotSourceRuntimeState, "runtime", "snapshots", false); err == nil {
		t.Fatal("not-ready snapshot unexpectedly accepted")
	}
}

func TestRejectSnapshotInUseByActiveRuntime(t *testing.T) {
	sessions := []clusterv1alpha1.T4Session{{
		ObjectMeta: metav1.ObjectMeta{Name: "active", Namespace: "team", UID: "active-uid"},
		Spec: clusterv1alpha1.T4SessionSpec{DesiredState: clusterv1alpha1.DesiredStateRunning, RuntimeStateRestoreSnapshotRef: &clusterv1alpha1.VolumeSnapshotReference{Name: "snapshot-a"}},
		Status: clusterv1alpha1.T4SessionStatus{PodName: "active-pod", FenceState: clusterv1alpha1.RuntimeFenceNoPriorWriter},
	}}
	if err := RejectSnapshotInUse(sessions, "team", "snapshot-a", "new-uid"); err == nil {
		t.Fatal("snapshot attached to active runtime unexpectedly accepted")
	}
	sessions[0].Spec.RuntimeStateRestoreSnapshotRef = nil
	sessions[0].Status.Checkpoint = &clusterv1alpha1.CheckpointStatus{
		RuntimeStateSnapshotRef: &clusterv1alpha1.VolumeSnapshotReference{Name: "snapshot-a"},
	}
	if err := RejectSnapshotInUse(sessions, "team", "snapshot-a", "new-uid"); err == nil {
		t.Fatal("checkpoint snapshot owned by an active runtime unexpectedly accepted")
	}
	sessions[0].Spec.DesiredState = clusterv1alpha1.DesiredStateSleeping
	sessions[0].Status.FenceState = clusterv1alpha1.RuntimeFenceProven
	if err := RejectSnapshotInUse(sessions, "team", "snapshot-a", "new-uid"); err == nil {
		t.Fatal("snapshot attached to a draining or stale-fence runtime unexpectedly accepted")
	}
	sessions[0].Status.PodName = ""
	if err := RejectSnapshotInUse(sessions, "team", "snapshot-a", "new-uid"); err != nil {
		t.Fatal(err)
	}
}
func TestValidateRestoreGenerationRequiresAllocatedAdvance(t *testing.T) {
	session := &clusterv1alpha1.T4Session{}
	snapshot := &unstructured.Unstructured{}
	snapshot.SetLabels(map[string]string{clusterv1alpha1.SnapshotGenerationLabel: "gen_source"})
	if err := validateRestoreGeneration(session, snapshot); err == nil {
		t.Fatal("restore without an allocated generation unexpectedly accepted")
	}
	session.Status.RuntimeGeneration = "gen_source"
	if err := validateRestoreGeneration(session, snapshot); err == nil {
		t.Fatal("restore reusing the source generation unexpectedly accepted")
	}
	session.Status.RuntimeGeneration = "gen_restored"
	if err := validateRestoreGeneration(session, snapshot); err != nil {
		t.Fatal(err)
	}
}


type checkpointLifecycleFixture struct {
	quiesceAck RuntimeShutdownAck
	reopens    int
}

func (fixture *checkpointLifecycleFixture) Activity(context.Context, *clusterv1alpha1.T4Session, *corev1.Pod) (RuntimeActivitySnapshot, error) {
	return RuntimeActivitySnapshot{}, nil
}
func (fixture *checkpointLifecycleFixture) DrainIfIdle(context.Context, *clusterv1alpha1.T4Session, *corev1.Pod) (RuntimeShutdownAck, error) {
	return fixture.quiesceAck, nil
}
func (fixture *checkpointLifecycleFixture) Quiesce(context.Context, *clusterv1alpha1.T4Session, *corev1.Pod) (RuntimeShutdownAck, error) {
	return fixture.quiesceAck, nil
}
func (fixture *checkpointLifecycleFixture) Reopen(context.Context, *clusterv1alpha1.T4Session, *corev1.Pod) error {
	fixture.reopens++
	return nil
}

func TestReconcileCheckpointRecordsExactAcksAndSeparateReadySnapshots(t *testing.T) {
	ctx := context.Background()
	host := storageHost()
	host.Status.StorageCapabilities = &clusterv1alpha1.StorageCapabilities{
		WorkspaceReadWriteMany: clusterv1alpha1.StorageCapabilityObservation{State: clusterv1alpha1.StorageCapabilitySupported},
		RuntimeStateReattach: clusterv1alpha1.StorageCapabilityObservation{State: clusterv1alpha1.StorageCapabilitySupported},
		VolumeSnapshots: clusterv1alpha1.StorageCapabilityObservation{State: clusterv1alpha1.StorageCapabilitySupported},
		SnapshotDataSource: clusterv1alpha1.StorageCapabilityObservation{State: clusterv1alpha1.StorageCapabilitySupported},
	}
	session := &clusterv1alpha1.T4Session{
		ObjectMeta: metav1.ObjectMeta{Name: "session", Namespace: "team", UID: "session-uid"},
		Spec: clusterv1alpha1.T4SessionSpec{
			PublicID: "runtime-public", BrowserPolicy: clusterv1alpha1.BrowserPolicyAllowed,
			Checkpoint: &clusterv1alpha1.CheckpointRequest{ID: "backup-1", Consistency: clusterv1alpha1.SnapshotConsistencyQuiesced},
		},
		Status: clusterv1alpha1.T4SessionStatus{RuntimeGeneration: "gen_current"},
	}
	workspace := &clusterv1alpha1.T4Workspace{ObjectMeta: metav1.ObjectMeta{Name: "workspace", Namespace: "team", UID: "workspace-uid"}, Spec: clusterv1alpha1.T4WorkspaceSpec{PublicID: "workspace-public"}}
	workspacePVC := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "workspace-pvc", Namespace: "team", Annotations: map[string]string{clusterv1alpha1.WorkspaceUIDAnnotation: "workspace-uid"}},
		Spec: corev1.PersistentVolumeClaimSpec{StorageClassName: pointer("rwx")},
	}
	runtimePVC := &corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Name: "runtime-pvc", Namespace: "team"}, Spec: corev1.PersistentVolumeClaimSpec{StorageClassName: pointer("runtime")}}
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "pod", Namespace: "team"}}
	workspaceClass := &storagev1.StorageClass{ObjectMeta: metav1.ObjectMeta{Name: "rwx"}, Provisioner: "fixture.csi.t4.dev"}
	runtimeClass := &storagev1.StorageClass{ObjectMeta: metav1.ObjectMeta{Name: "runtime"}, Provisioner: "fixture.csi.t4.dev"}
	snapshotClass := volumeSnapshotClass("snapshots", "fixture.csi.t4.dev", nil)
	c := fake.NewClientBuilder().WithScheme(storageTestScheme(t)).
		WithStatusSubresource(&clusterv1alpha1.T4Session{}).
		WithObjects(session, workspace, workspacePVC, runtimePVC, pod, workspaceClass, runtimeClass, snapshotClass).Build()
	lifecycle := &checkpointLifecycleFixture{quiesceAck: RuntimeShutdownAck{
		SchemaVersion: 1, Generation: "gen_current", Durable: true,
		DurableAcks: clusterv1alpha1.DurableComponentAcknowledgements{OMP: true, Cmux: true, Browser: true},
	}}
	reconciler := &SessionReconciler{Client: c, APIReader: c, Scheme: storageTestScheme(t), RuntimeLifecycle: lifecycle}

	var current clusterv1alpha1.T4Session
	if err := c.Get(ctx, clientKey(session), &current); err != nil {
		t.Fatal(err)
	}
	waiting, err := reconciler.reconcileCheckpoint(ctx, &current, pod, workspace, workspacePVC, runtimePVC, host)
	if err != nil || !waiting {
		t.Fatalf("initial checkpoint waiting=%v err=%v", waiting, err)
	}
	if current.Status.Checkpoint == nil || !current.Status.Checkpoint.DurableAcks.OMP || !current.Status.Checkpoint.DurableAcks.Cmux || !current.Status.Checkpoint.DurableAcks.Browser {
		t.Fatalf("checkpoint status = %#v", current.Status.Checkpoint)
	}
	for _, ref := range []*clusterv1alpha1.VolumeSnapshotReference{current.Status.Checkpoint.WorkspaceSnapshotRef, current.Status.Checkpoint.RuntimeStateSnapshotRef} {
		snapshot := &unstructured.Unstructured{}
		snapshot.SetGroupVersionKind(volumeSnapshotGVK)
		if err := c.Get(ctx, types.NamespacedName{Namespace: "team", Name: ref.Name}, snapshot); err != nil {
			t.Fatal(err)
		}
		if err := unstructured.SetNestedField(snapshot.Object, map[string]any{"readyToUse": true}, "status"); err != nil {
			t.Fatal(err)
		}
		if err := c.Update(ctx, snapshot); err != nil {
			t.Fatal(err)
		}
	}
	if err := c.Get(ctx, clientKey(session), &current); err != nil {
		t.Fatal(err)
	}
	waiting, err = reconciler.reconcileCheckpoint(ctx, &current, pod, workspace, workspacePVC, runtimePVC, host)
	if err != nil || waiting {
		t.Fatalf("completed checkpoint waiting=%v err=%v", waiting, err)
	}
	if current.Status.Checkpoint.CompletedAt == nil || lifecycle.reopens != 1 {
		t.Fatalf("completed checkpoint = %#v, reopens=%d", current.Status.Checkpoint, lifecycle.reopens)
	}
}

func TestWorkspaceRestoreValidatesSnapshotAndUsesImmutableDataSource(t *testing.T) {
	ctx := context.Background()
	host := storageHost()
	host.Name = "host"
	host.Namespace = "team"
	workspace := &clusterv1alpha1.T4Workspace{
		ObjectMeta: metav1.ObjectMeta{Name: "restored", Namespace: "team", UID: "restored-uid"},
		Spec: clusterv1alpha1.T4WorkspaceSpec{
			PublicID: "workspace-public", HostRef: "host", DisplayName: "restored", Owner: "owner",
			Size: resource.MustParse("1Gi"), RetentionPolicy: clusterv1alpha1.RetentionPolicyDelete,
			RestoreSnapshotRef: &clusterv1alpha1.VolumeSnapshotReference{Name: "workspace-snapshot"},
		},
	}
	source := &corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Name: "workspace-source", Namespace: "team"}, Spec: corev1.PersistentVolumeClaimSpec{StorageClassName: pointer("rwx")}}
	snapshot := NewVolumeSnapshot("team", "workspace-snapshot", "snapshots", source.Name, SnapshotSourceWorkspace, string(clusterv1alpha1.SnapshotConsistencyQuiesced), "gen_source", nil)
	snapshot.SetAnnotations(map[string]string{SnapshotWorkspacePublicIDAnnotation: workspace.Spec.PublicID})
	if err := unstructured.SetNestedField(snapshot.Object, map[string]any{"readyToUse": true}, "status"); err != nil {
		t.Fatal(err)
	}
	workspaceClass := &storagev1.StorageClass{ObjectMeta: metav1.ObjectMeta{Name: "rwx", Annotations: map[string]string{clusterv1alpha1.RWXStorageClassAnnotation: string(corev1.ReadWriteMany)}}, Provisioner: "fixture.csi.t4.dev"}
	snapshotClass := volumeSnapshotClass("snapshots", "fixture.csi.t4.dev", nil)
	scheme := storageTestScheme(t)
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Workspace{}).
		WithIndex(&clusterv1alpha1.T4Session{}, workspaceSessionRefIndexField, indexWorkspaceSessionByWorkspaceRef).
		WithObjects(host, workspace, source, snapshot, workspaceClass, snapshotClass).Build()
	reconciler := &WorkspaceReconciler{Client: c, APIReader: c, Scheme: scheme}
	for range 2 {
		if _, err := reconciler.Reconcile(ctx, ctrl.Request{NamespacedName: clientKey(workspace)}); err != nil {
			t.Fatal(err)
		}
	}
	var restored corev1.PersistentVolumeClaim
	if err := c.Get(ctx, types.NamespacedName{Namespace: "team", Name: WorkspacePVCName(workspace)}, &restored); err != nil {
		t.Fatal(err)
	}
	if restored.Spec.DataSource == nil || restored.Spec.DataSource.Name != snapshot.GetName() || restored.Spec.DataSource.Kind != "VolumeSnapshot" {
		t.Fatalf("workspace restore data source = %#v", restored.Spec.DataSource)
	}
}

func clientKey(object metav1.Object) types.NamespacedName {
	return types.NamespacedName{Namespace: object.GetNamespace(), Name: object.GetName()}
}

func storageHost() *clusterv1alpha1.T4ClusterHost {
	return &clusterv1alpha1.T4ClusterHost{Spec: clusterv1alpha1.T4ClusterHostSpec{
		StorageClassName: "rwx",
		RuntimeStateStorageProfile: &clusterv1alpha1.RuntimeStateStorageProfile{
			StorageClassName: "runtime", Size: resource.MustParse("1Gi"), AccessMode: clusterv1alpha1.RuntimeStateAccessModeReadWriteOncePod, VolumeSnapshotClassName: "snapshots",
		},
	}}
}

func volumeSnapshotClass(name, driver string, annotations map[string]string) *unstructured.Unstructured {
	object := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "snapshot.storage.k8s.io/v1", "kind": "VolumeSnapshotClass",
		"metadata": map[string]any{"name": name}, "driver": driver, "deletionPolicy": "Retain",
	}}
	object.SetGroupVersionKind(volumeSnapshotClassGVK)
	object.SetAnnotations(annotations)
	return object
}

func unstructuredSet(object *unstructured.Unstructured, value any, fields ...string) error {
	return unstructured.SetNestedField(object.Object, value, fields...)
}

func pointer(value string) *string { return &value }

