package controllers

import (
	"context"
	"errors"
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
	storagev1 "k8s.io/api/storage/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apiMeta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"

	clusterv1alpha1 "github.com/wolfiesch/omperator/packages/cluster-operator/api/v1alpha1"
)

const (
	StorageConformanceRWXAnnotation        = "cluster.t4.dev/conformance-rwx-remount"
	StorageConformanceReattachAnnotation   = "cluster.t4.dev/conformance-runtime-reattach"
	StorageConformanceSnapshotAnnotation   = "cluster.t4.dev/conformance-snapshot-restore"
	CheckpointOMPAckAnnotation             = "cluster.t4.dev/checkpoint-omp-ack"
	CheckpointCmuxAckAnnotation            = "cluster.t4.dev/checkpoint-cmux-ack"
	CheckpointBrowserAckAnnotation         = "cluster.t4.dev/checkpoint-browser-ack"
	SnapshotSourceWorkspace                = "workspace"
	SnapshotPublicIDAnnotation            = "cluster.t4.dev/source-public-id"
	SnapshotWorkspacePublicIDAnnotation   = "cluster.t4.dev/source-workspace-public-id"
	SnapshotSourceRuntimeState             = "runtime-state"
)

var volumeSnapshotGVK = schema.GroupVersionKind{Group: "snapshot.storage.k8s.io", Version: "v1", Kind: "VolumeSnapshot"}
var volumeSnapshotClassGVK = schema.GroupVersionKind{Group: "snapshot.storage.k8s.io", Version: "v1", Kind: "VolumeSnapshotClass"}

// ObserveStorageCapabilities produces a bounded, infrastructure-only observation.
// Remount/reattach and snapshot claims remain Unknown until a conformance run has
// placed the exact successful marker on the selected class; configuration alone
// is never treated as proof.
func ObserveStorageCapabilities(ctx context.Context, reader client.Reader, host *clusterv1alpha1.T4ClusterHost, now metav1.Time) (*clusterv1alpha1.StorageCapabilities, error) {
	if host.Spec.RuntimeStateStorageProfile == nil {
		return nil, errors.New("runtime-state storage profile is required")
	}
	workspaceClass := &storagev1.StorageClass{}
	if err := reader.Get(ctx, types.NamespacedName{Name: host.Spec.StorageClassName}, workspaceClass); err != nil {
		return nil, fmt.Errorf("read workspace StorageClass: %w", err)
	}
	runtimeClass := &storagev1.StorageClass{}
	if err := reader.Get(ctx, types.NamespacedName{Name: host.Spec.RuntimeStateStorageProfile.StorageClassName}, runtimeClass); err != nil {
		return nil, fmt.Errorf("read runtime-state StorageClass: %w", err)
	}

	result := &clusterv1alpha1.StorageCapabilities{
		WorkspaceReadWriteMany: observation(storageClassAllowsRWX(workspaceClass.Annotations), "AccessModeDeclared", "ReadWriteManyNotDeclared"),
		RuntimeStateReattach:   markerObservation(runtimeClass.Annotations[StorageConformanceReattachAnnotation], "ReattachConformancePassed"),
		OnlineExpansion:        observation(storageClassAllowsExpansion(workspaceClass) && storageClassAllowsExpansion(runtimeClass), "ExpansionAllowed", "ExpansionNotAllowed"),
		VolumeSnapshots:        clusterv1alpha1.StorageCapabilityObservation{State: clusterv1alpha1.StorageCapabilityUnknown, Reason: "SnapshotClassNotObserved"},
		SnapshotDataSource:     clusterv1alpha1.StorageCapabilityObservation{State: clusterv1alpha1.StorageCapabilityUnknown, Reason: "SnapshotClassNotObserved"},
		ObservedAt: now,
		WorkspaceStorageClassName: host.Spec.StorageClassName,
		RuntimeStateStorageClassName: host.Spec.RuntimeStateStorageProfile.StorageClassName,
		VolumeSnapshotClassName: host.Spec.RuntimeStateStorageProfile.VolumeSnapshotClassName,
	}
	if result.WorkspaceReadWriteMany.State == clusterv1alpha1.StorageCapabilitySupported {
		result.WorkspaceReadWriteMany = markerObservation(workspaceClass.Annotations[StorageConformanceRWXAnnotation], "RWXRemountConformancePassed")
	}

	if result.VolumeSnapshotClassName == "" {
		return result, nil
	}
	snapshotClass := &unstructured.Unstructured{}
	snapshotClass.SetGroupVersionKind(volumeSnapshotClassGVK)
	if err := reader.Get(ctx, types.NamespacedName{Name: result.VolumeSnapshotClassName}, snapshotClass); err != nil {
		if apierrors.IsNotFound(err) || apiMeta.IsNoMatchError(err) {
			result.VolumeSnapshots = clusterv1alpha1.StorageCapabilityObservation{State: clusterv1alpha1.StorageCapabilityUnsupported, Reason: "SnapshotClassNotFound"}
			result.SnapshotDataSource = result.VolumeSnapshots
			return result, nil
		}
		return nil, fmt.Errorf("read VolumeSnapshotClass: %w", err)
	}
	driver, _, _ := unstructured.NestedString(snapshotClass.Object, "driver")
	compatibleDriver := driver != "" && driver == workspaceClass.Provisioner && driver == runtimeClass.Provisioner
	if !compatibleDriver {
		result.VolumeSnapshots = clusterv1alpha1.StorageCapabilityObservation{State: clusterv1alpha1.StorageCapabilityUnsupported, Reason: "SnapshotDriverMismatch"}
		result.SnapshotDataSource = result.VolumeSnapshots
		return result, nil
	}
	marker := snapshotClass.GetAnnotations()[StorageConformanceSnapshotAnnotation]
	result.VolumeSnapshots = markerObservation(marker, "SnapshotConformancePassed")
	result.SnapshotDataSource = result.VolumeSnapshots
	return result, nil
}

func observation(supported bool, supportedReason, unsupportedReason string) clusterv1alpha1.StorageCapabilityObservation {
	if supported {
		return clusterv1alpha1.StorageCapabilityObservation{State: clusterv1alpha1.StorageCapabilitySupported, Reason: supportedReason}
	}
	return clusterv1alpha1.StorageCapabilityObservation{State: clusterv1alpha1.StorageCapabilityUnsupported, Reason: unsupportedReason}
}

func markerObservation(value, reason string) clusterv1alpha1.StorageCapabilityObservation {
	if value == "passed" {
		return clusterv1alpha1.StorageCapabilityObservation{State: clusterv1alpha1.StorageCapabilitySupported, Reason: reason}
	}
	return clusterv1alpha1.StorageCapabilityObservation{State: clusterv1alpha1.StorageCapabilityUnknown, Reason: "ConformanceNotObserved"}
}
func storageClassAllowsExpansion(storageClass *storagev1.StorageClass) bool {
	return storageClass.AllowVolumeExpansion != nil && *storageClass.AllowVolumeExpansion
}


func StorageCapabilitiesPermitRuntime(host *clusterv1alpha1.T4ClusterHost) error {
	capabilities := host.Status.StorageCapabilities
	if capabilities == nil {
		return errors.New("storage capabilities have not been observed")
	}
	checks := []struct {
		name string
		value clusterv1alpha1.StorageCapabilityObservation
	}{
		{"workspace ReadWriteMany remount", capabilities.WorkspaceReadWriteMany},
		{"runtime-state reattach", capabilities.RuntimeStateReattach},
	}
	for _, check := range checks {
		if check.value.State != clusterv1alpha1.StorageCapabilitySupported {
			return fmt.Errorf("%s is %s (%s)", check.name, check.value.State, check.value.Reason)
		}
	}
	profile := host.Spec.RuntimeStateStorageProfile
	if profile == nil || !clusterv1alpha1.ValidRuntimeStateAccessMode(profile.AccessMode) {
		return errors.New("runtime-state access mode must be ReadWriteOncePod or ReadWriteOnce")
	}
	if capabilities.WorkspaceStorageClassName != host.Spec.StorageClassName ||
		capabilities.RuntimeStateStorageClassName != profile.StorageClassName {
		return errors.New("storage capability observation does not match the selected StorageClasses")
	}
	return nil
}

func RuntimeStatePVCMode(profile *clusterv1alpha1.RuntimeStateStorageProfile) (corev1.PersistentVolumeAccessMode, error) {
	if profile == nil {
		return "", errors.New("runtime-state storage profile is required")
	}
	switch profile.AccessMode {
	case "", clusterv1alpha1.RuntimeStateAccessModeReadWriteOncePod:
		return corev1.ReadWriteOncePod, nil
	case clusterv1alpha1.RuntimeStateAccessModeReadWriteOnce:
		return corev1.ReadWriteOnce, nil
	default:
		return "", fmt.Errorf("unsupported runtime-state access mode %q", profile.AccessMode)
	}
}

func CheckpointDurableAcks(session *clusterv1alpha1.T4Session, pod *corev1.Pod) (clusterv1alpha1.DurableComponentAcknowledgements, error) {
	generation := session.Status.RuntimeGeneration
	if generation == "" {
		return clusterv1alpha1.DurableComponentAcknowledgements{}, errors.New("runtime generation is not committed")
	}
	if pod == nil || pod.Labels["cluster.t4.dev/runtime-generation"] != generation {
		return clusterv1alpha1.DurableComponentAcknowledgements{}, errors.New("checkpoint pod does not match the current runtime generation")
	}
	acks := clusterv1alpha1.DurableComponentAcknowledgements{
		OMP: pod.Annotations[CheckpointOMPAckAnnotation] == generation,
		Cmux: pod.Annotations[CheckpointCmuxAckAnnotation] == generation,
		Browser: pod.Annotations[CheckpointBrowserAckAnnotation] == generation,
	}
	if !acks.OMP || !acks.Cmux || session.Spec.BrowserPolicy == clusterv1alpha1.BrowserPolicyAllowed && !acks.Browser {
		return acks, errors.New("durable acknowledgement is missing for the current runtime generation")
	}
	return acks, nil
}

func NewVolumeSnapshot(namespace, name, className, pvcName, source, consistency, generation string, labels map[string]string) *unstructured.Unstructured {
	objectLabels := map[string]string{
		clusterv1alpha1.SnapshotSourceLabel: source,
		clusterv1alpha1.SnapshotConsistencyLabel: consistency,
		clusterv1alpha1.SnapshotGenerationLabel: generation,
	}
	for key, value := range labels {
		objectLabels[key] = value
	}
	object := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "snapshot.storage.k8s.io/v1",
		"kind": "VolumeSnapshot",
		"metadata": map[string]any{"name": name, "namespace": namespace},
		"spec": map[string]any{
			"volumeSnapshotClassName": className,
			"source": map[string]any{"persistentVolumeClaimName": pvcName},
		},
	}}
	object.SetGroupVersionKind(volumeSnapshotGVK)
	object.SetLabels(objectLabels)
	return object
}

// ValidateRestoreSnapshot checks readiness, immutable source shape, namespace,
// class/driver compatibility, and the consistency label before a PVC may use it.
func ValidateRestoreSnapshot(ctx context.Context, reader client.Reader, namespace string, ref *clusterv1alpha1.VolumeSnapshotReference, expectedSource, storageClassName, snapshotClassName string, allowCrashConsistent bool) (*unstructured.Unstructured, error) {
	if ref == nil || ref.Name == "" {
		return nil, errors.New("snapshot reference is required")
	}
	snapshot := &unstructured.Unstructured{}
	snapshot.SetGroupVersionKind(volumeSnapshotGVK)
	if err := reader.Get(ctx, types.NamespacedName{Namespace: namespace, Name: ref.Name}, snapshot); err != nil {
		return nil, fmt.Errorf("read VolumeSnapshot: %w", err)
	}
	ready, found, err := unstructured.NestedBool(snapshot.Object, "status", "readyToUse")
	if err != nil || !found || !ready {
		return nil, errors.New("VolumeSnapshot is not ReadyToUse")
	}
	className, _, _ := unstructured.NestedString(snapshot.Object, "spec", "volumeSnapshotClassName")
	if className != snapshotClassName {
		return nil, fmt.Errorf("VolumeSnapshotClass %q does not match %q", className, snapshotClassName)
	}
	sourcePVC, _, _ := unstructured.NestedString(snapshot.Object, "spec", "source", "persistentVolumeClaimName")
	sourceContent, _, _ := unstructured.NestedString(snapshot.Object, "spec", "source", "volumeSnapshotContentName")
	if sourcePVC == "" || sourceContent != "" {
		return nil, errors.New("VolumeSnapshot must be a namespaced PVC snapshot")
	}
	if snapshot.GetLabels()[clusterv1alpha1.SnapshotSourceLabel] != expectedSource {
		return nil, errors.New("VolumeSnapshot source kind is incompatible")
	}
	sourceGeneration := snapshot.GetLabels()[clusterv1alpha1.SnapshotGenerationLabel]
	if len(sourceGeneration) < 8 || !strings.HasPrefix(sourceGeneration, "gen_") {
		return nil, errors.New("VolumeSnapshot does not identify a valid source runtime generation")
	}
	consistency := snapshot.GetLabels()[clusterv1alpha1.SnapshotConsistencyLabel]
	if consistency != string(clusterv1alpha1.SnapshotConsistencyQuiesced) && !(allowCrashConsistent && consistency == string(clusterv1alpha1.SnapshotConsistencyCrashConsistent)) {
		return nil, fmt.Errorf("VolumeSnapshot consistency %q is not accepted", consistency)
	}
	pvc := &corev1.PersistentVolumeClaim{}
	if err := reader.Get(ctx, types.NamespacedName{Namespace: namespace, Name: sourcePVC}, pvc); err != nil {
		return nil, fmt.Errorf("read snapshot source PVC: %w", err)
	}
	if pvcStorageClassName(pvc) != storageClassName {
		return nil, errors.New("snapshot source storage class is incompatible")
	}
	storageClass := &storagev1.StorageClass{}
	if err := reader.Get(ctx, types.NamespacedName{Name: storageClassName}, storageClass); err != nil {
		return nil, fmt.Errorf("read restore StorageClass: %w", err)
	}
	snapshotClass := &unstructured.Unstructured{}
	snapshotClass.SetGroupVersionKind(volumeSnapshotClassGVK)
	if err := reader.Get(ctx, types.NamespacedName{Name: snapshotClassName}, snapshotClass); err != nil {
		return nil, fmt.Errorf("read restore VolumeSnapshotClass: %w", err)
	}
	driver, found, err := unstructured.NestedString(snapshotClass.Object, "driver")
	if err != nil || !found || driver == "" || driver != storageClass.Provisioner {
		return nil, errors.New("snapshot and target StorageClass drivers are incompatible")
	}
	return snapshot, nil
}
func validateRestoreGeneration(session *clusterv1alpha1.T4Session, snapshot *unstructured.Unstructured) error {
	current := session.Status.RuntimeGeneration
	if current == "" {
		return errors.New("runtime-state restore requires an allocated fenced runtime generation")
	}
	if snapshot.GetLabels()[clusterv1alpha1.SnapshotGenerationLabel] == current {
		return errors.New("runtime-state restore requires a new fenced runtime generation")
	}
	return nil
}


func ValidateRestorePublicID(session *clusterv1alpha1.T4Session, snapshot *unstructured.Unstructured) error {
	sourceID := snapshot.GetAnnotations()[SnapshotPublicIDAnnotation]
	if sourceID == "" {
		return errors.New("snapshot does not record its stable public ID")
	}
	policy := session.Spec.RestorePublicIDPolicy
	if policy == "" {
		policy = clusterv1alpha1.RestorePublicIDPreserve
	}
	switch policy {
	case clusterv1alpha1.RestorePublicIDPreserve:
		if session.Spec.PublicID != sourceID {
			return errors.New("preserving restore must use the snapshot stable public ID")
		}
	case clusterv1alpha1.RestorePublicIDReplace:
		if session.Spec.PublicID == "" || session.Spec.PublicID == sourceID {
			return errors.New("replacement restore requires an explicit new stable public ID")
		}
	default:
		return fmt.Errorf("unsupported restore public ID policy %q", policy)
	}
	return nil
}

func ValidateWorkspaceRestorePublicID(workspace *clusterv1alpha1.T4Workspace, snapshot *unstructured.Unstructured) error {
	sourceID := snapshot.GetAnnotations()[SnapshotWorkspacePublicIDAnnotation]
	if sourceID == "" {
		return errors.New("workspace snapshot does not record its stable public ID")
	}
	policy := workspace.Spec.RestorePublicIDPolicy
	if policy == "" {
		policy = clusterv1alpha1.RestorePublicIDPreserve
	}
	if policy == clusterv1alpha1.RestorePublicIDPreserve && workspace.Spec.PublicID != sourceID {
		return errors.New("preserving workspace restore must use the snapshot stable public ID")
	}
	if policy == clusterv1alpha1.RestorePublicIDReplace && (workspace.Spec.PublicID == "" || workspace.Spec.PublicID == sourceID) {
		return errors.New("workspace replacement restore requires an explicit new stable public ID")
	}
	if policy != clusterv1alpha1.RestorePublicIDPreserve && policy != clusterv1alpha1.RestorePublicIDReplace {
		return fmt.Errorf("unsupported workspace restore public ID policy %q", policy)
	}
	return nil
}

func RejectSnapshotInUse(sessions []clusterv1alpha1.T4Session, namespace, snapshotName string, exceptUID types.UID) error {
	for index := range sessions {
		session := &sessions[index]
		if session.Namespace != namespace || session.UID == exceptUID || session.Status.PodName == "" {
			continue
		}
		restoreRef := session.Spec.RuntimeStateRestoreSnapshotRef
		checkpointRef := (*clusterv1alpha1.VolumeSnapshotReference)(nil)
		if session.Status.Checkpoint != nil {
			checkpointRef = session.Status.Checkpoint.RuntimeStateSnapshotRef
		}
		if restoreRef != nil && restoreRef.Name == snapshotName || checkpointRef != nil && checkpointRef.Name == snapshotName {
			return fmt.Errorf("snapshot %q is in use by an active runtime", snapshotName)
		}
	}
	return nil
}

func (r *SessionReconciler) reconcileCheckpoint(ctx context.Context, session *clusterv1alpha1.T4Session, pod *corev1.Pod, workspace *clusterv1alpha1.T4Workspace, workspacePVC, runtimePVC *corev1.PersistentVolumeClaim, host *clusterv1alpha1.T4ClusterHost) (bool, error) {
	request := session.Spec.Checkpoint
	if request == nil {
		return false, nil
	}
	profile := host.Spec.RuntimeStateStorageProfile
	if profile == nil || profile.VolumeSnapshotClassName == "" {
		return true, errors.New("checkpoint requires runtime-state storage and a VolumeSnapshotClass")
	}
	capabilities := host.Status.StorageCapabilities
	if capabilities == nil || capabilities.VolumeSnapshots.State != clusterv1alpha1.StorageCapabilitySupported || capabilities.SnapshotDataSource.State != clusterv1alpha1.StorageCapabilitySupported {
		return true, errors.New("checkpoint requires observed snapshot and snapshot data-source capabilities")
	}
	consistency := request.Consistency
	if consistency == "" {
		consistency = clusterv1alpha1.SnapshotConsistencyQuiesced
	}
	if consistency != clusterv1alpha1.SnapshotConsistencyQuiesced && consistency != clusterv1alpha1.SnapshotConsistencyCrashConsistent {
		return true, fmt.Errorf("unsupported checkpoint consistency %q", consistency)
	}
	generation := session.Status.RuntimeGeneration
	if generation == "" {
		return true, errors.New("checkpoint requires a committed runtime generation")
	}
	if current := session.Status.Checkpoint; current != nil {
		if current.RequestID != request.ID || current.RuntimeGeneration != generation || current.Consistency != consistency {
			return true, errors.New("checkpoint request ID is already bound to different immutable checkpoint inputs")
		}
		if current.CompletedAt != nil {
			if consistency == clusterv1alpha1.SnapshotConsistencyQuiesced {
				if r.RuntimeLifecycle == nil {
					return true, errors.New("completed quiesced checkpoint cannot reopen without a runtime lifecycle client")
				}
				if err := r.RuntimeLifecycle.Reopen(ctx, session, pod); err != nil {
					return true, fmt.Errorf("reopen runtime after checkpoint: %w", err)
				}
			}
			return false, nil
		}
	}

	workspaceName := SnapshotName(session, request.ID, SnapshotSourceWorkspace)
	runtimeName := SnapshotName(session, request.ID, SnapshotSourceRuntimeState)
	if session.Status.Checkpoint == nil {
		acks := clusterv1alpha1.DurableComponentAcknowledgements{}
		if consistency == clusterv1alpha1.SnapshotConsistencyQuiesced {
			if r.RuntimeLifecycle == nil {
				return true, errors.New("quiesced checkpoint requires a runtime lifecycle client")
			}
			ack, err := r.RuntimeLifecycle.Quiesce(ctx, session, pod)
			if err != nil {
				return true, fmt.Errorf("quiesce runtime for checkpoint: %w", err)
			}
			if ack.SchemaVersion != 1 || ack.Generation != generation || !ack.Durable || !ack.DurableAcks.OMP || !ack.DurableAcks.Cmux || !ack.DurableAcks.Browser {
				return true, errors.New("quiesce did not durably acknowledge OMP, cmux, and browser for the exact runtime generation")
			}
			acks = ack.DurableAcks
		}
		labels := map[string]string{
			clusterv1alpha1.SnapshotSessionUIDLabel: string(session.UID),
		}
		workspaceSnapshot := NewVolumeSnapshot(session.Namespace, workspaceName, profile.VolumeSnapshotClassName, workspacePVC.Name, SnapshotSourceWorkspace, string(consistency), generation, labels)
		workspaceSnapshot.SetAnnotations(map[string]string{SnapshotWorkspacePublicIDAnnotation: workspace.Spec.PublicID})
		workspaceSnapshot.SetLabels(mergeStringMaps(workspaceSnapshot.GetLabels(), map[string]string{clusterv1alpha1.SnapshotWorkspaceUIDLabel: workspacePVC.Annotations[clusterv1alpha1.WorkspaceUIDAnnotation]}))
		runtimeSnapshot := NewVolumeSnapshot(session.Namespace, runtimeName, profile.VolumeSnapshotClassName, runtimePVC.Name, SnapshotSourceRuntimeState, string(consistency), generation, labels)
		runtimeSnapshot.SetAnnotations(map[string]string{SnapshotPublicIDAnnotation: session.Spec.PublicID})
		for _, snapshot := range []*unstructured.Unstructured{workspaceSnapshot, runtimeSnapshot} {
			if err := r.Create(ctx, snapshot); err != nil {
				if !apierrors.IsAlreadyExists(err) {
					return true, err
				}
				existing := &unstructured.Unstructured{}
				existing.SetGroupVersionKind(volumeSnapshotGVK)
				if err := r.Get(ctx, client.ObjectKeyFromObject(snapshot), existing); err != nil {
					return true, err
				}
				if err := validateCheckpointSnapshotIdentity(existing, snapshot); err != nil {
					return true, err
				}
			}
		}
		session.Status.Checkpoint = &clusterv1alpha1.CheckpointStatus{
			RequestID: request.ID, RuntimeGeneration: generation, Consistency: consistency, DurableAcks: acks,
			WorkspaceSnapshotRef: &clusterv1alpha1.VolumeSnapshotReference{Name: workspaceName},
			RuntimeStateSnapshotRef: &clusterv1alpha1.VolumeSnapshotReference{Name: runtimeName},
		}
		if err := r.Status().Update(ctx, session); err != nil {
			return true, err
		}
		return true, nil
	}

	workspaceReady, err := checkpointSnapshotReady(ctx, r.Client, session.Namespace, workspaceName)
	if err != nil {
		return true, err
	}
	runtimeReady, err := checkpointSnapshotReady(ctx, r.Client, session.Namespace, runtimeName)
	if err != nil {
		return true, err
	}
	if !workspaceReady || !runtimeReady {
		return true, nil
	}
	if _, err := ValidateRestoreSnapshot(ctx, r.Client, session.Namespace, session.Status.Checkpoint.WorkspaceSnapshotRef, SnapshotSourceWorkspace, pvcStorageClassName(workspacePVC), profile.VolumeSnapshotClassName, consistency == clusterv1alpha1.SnapshotConsistencyCrashConsistent); err != nil {
		return true, fmt.Errorf("validate workspace checkpoint snapshot: %w", err)
	}
	if _, err := ValidateRestoreSnapshot(ctx, r.Client, session.Namespace, session.Status.Checkpoint.RuntimeStateSnapshotRef, SnapshotSourceRuntimeState, pvcStorageClassName(runtimePVC), profile.VolumeSnapshotClassName, consistency == clusterv1alpha1.SnapshotConsistencyCrashConsistent); err != nil {
		return true, fmt.Errorf("validate runtime-state checkpoint snapshot: %w", err)
	}
	if consistency == clusterv1alpha1.SnapshotConsistencyQuiesced {
		if r.RuntimeLifecycle == nil {
			return true, errors.New("quiesced checkpoint cannot reopen without a runtime lifecycle client")
		}
		if err := r.RuntimeLifecycle.Reopen(ctx, session, pod); err != nil {
			return true, fmt.Errorf("reopen runtime after checkpoint: %w", err)
		}
	}
	completedAt := metav1.Now()
	session.Status.Checkpoint.CompletedAt = &completedAt
	if err := r.Status().Update(ctx, session); err != nil {
		return true, err
	}
	return false, nil
}

func mergeStringMaps(left, right map[string]string) map[string]string {
	result := make(map[string]string, len(left)+len(right))
	for key, value := range left {
		result[key] = value
	}
	for key, value := range right {
		if value != "" {
			result[key] = value
		}
	}
	return result
}

func validateCheckpointSnapshotIdentity(actual, expected *unstructured.Unstructured) error {
	actualClass, _, _ := unstructured.NestedString(actual.Object, "spec", "volumeSnapshotClassName")
	expectedClass, _, _ := unstructured.NestedString(expected.Object, "spec", "volumeSnapshotClassName")
	actualPVC, _, _ := unstructured.NestedString(actual.Object, "spec", "source", "persistentVolumeClaimName")
	expectedPVC, _, _ := unstructured.NestedString(expected.Object, "spec", "source", "persistentVolumeClaimName")
	if actual.GetNamespace() != expected.GetNamespace() || actualClass != expectedClass || actualPVC != expectedPVC ||
		actual.GetLabels()[clusterv1alpha1.SnapshotSourceLabel] != expected.GetLabels()[clusterv1alpha1.SnapshotSourceLabel] ||
		actual.GetLabels()[clusterv1alpha1.SnapshotConsistencyLabel] != expected.GetLabels()[clusterv1alpha1.SnapshotConsistencyLabel] ||
		actual.GetLabels()[clusterv1alpha1.SnapshotGenerationLabel] != expected.GetLabels()[clusterv1alpha1.SnapshotGenerationLabel] {
		return errors.New("existing VolumeSnapshot does not match immutable checkpoint identity")
	}
	return nil
}

func checkpointSnapshotReady(ctx context.Context, reader client.Reader, namespace, name string) (bool, error) {
	snapshot := &unstructured.Unstructured{}
	snapshot.SetGroupVersionKind(volumeSnapshotGVK)
	if err := reader.Get(ctx, types.NamespacedName{Namespace: namespace, Name: name}, snapshot); err != nil {
		return false, err
	}
	ready, found, err := unstructured.NestedBool(snapshot.Object, "status", "readyToUse")
	if err != nil {
		return false, err
	}
	return found && ready, nil
}

func SnapshotName(session *clusterv1alpha1.T4Session, requestID, source string) string {
	return stableName("t4-snap-", strings.ToLower(requestID+"-"+source), session.UID)
}
