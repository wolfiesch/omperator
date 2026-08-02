package controllers

import (
	"context"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"testing"

	coordinationv1 "k8s.io/api/coordination/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	storagev1 "k8s.io/api/storage/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	meta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	clusterv1alpha1 "github.com/wolfiesch/omperator/packages/cluster-operator/api/v1alpha1"
)

var runtimeGenerationPattern = regexp.MustCompile(`^gen_[A-Za-z0-9_-]{24}$`)

func TestPerSessionWriterAccessCannotReachSiblingLease(t *testing.T) {
	scheme := runtime.NewScheme()
	for _, add := range []func(*runtime.Scheme) error{corev1.AddToScheme, rbacv1.AddToScheme, clusterv1alpha1.AddToScheme} {
		if err := add(scheme); err != nil {
			t.Fatal(err)
		}
	}
	c := fake.NewClientBuilder().WithScheme(scheme).Build()
	r := &SessionReconciler{Client: c, APIReader: c, Scheme: scheme, SessionTokenReviewerClusterRoleName: "release-session-token-reviewer"}
	first := &clusterv1alpha1.T4Session{ObjectMeta: metav1.ObjectMeta{Name: "first", Namespace: "team", UID: "uid-first"}}
	second := &clusterv1alpha1.T4Session{ObjectMeta: metav1.ObjectMeta{Name: "second", Namespace: "team", UID: "uid-second"}}
	for _, session := range []*clusterv1alpha1.T4Session{first, second} {
		if err := r.ensureSessionAccess(t.Context(), session); err != nil {
			t.Fatal(err)
		}
	}
	for _, test := range []struct {
		session *clusterv1alpha1.T4Session
		sibling *clusterv1alpha1.T4Session
	}{
		{session: first, sibling: second},
		{session: second, sibling: first},
	} {
		var role rbacv1.Role
		if err := c.Get(t.Context(), types.NamespacedName{Namespace: "team", Name: SessionWriterRoleName(test.session)}, &role); err != nil {
			t.Fatal(err)
		}
		if len(role.Rules) != 1 || !reflect.DeepEqual(role.Rules[0].ResourceNames, []string{SessionWriterLeaseName(test.session)}) ||
			!reflect.DeepEqual(role.Rules[0].Verbs, []string{"get", "update"}) {
			t.Fatalf("session writer Role is not exact: %#v", role.Rules)
		}
		if slices.Contains(role.Rules[0].ResourceNames, SessionWriterLeaseName(test.sibling)) {
			t.Fatalf("%s writer Role can access sibling Lease %s", test.session.Name, SessionWriterLeaseName(test.sibling))
		}
		var serviceAccount corev1.ServiceAccount
		if err := c.Get(t.Context(), types.NamespacedName{Namespace: "team", Name: SessionServiceAccountName(test.session)}, &serviceAccount); err != nil {
			t.Fatal(err)
		}
		if serviceAccount.AutomountServiceAccountToken == nil || *serviceAccount.AutomountServiceAccountToken {
			t.Fatal("per-session ServiceAccount enables ambient token mounting")
		}
		var tokenBinding rbacv1.ClusterRoleBinding
		if err := c.Get(t.Context(), types.NamespacedName{Name: SessionTokenReviewBindingName(test.session)}, &tokenBinding); err != nil {
			t.Fatal(err)
		}
		if tokenBinding.RoleRef.Name != "release-session-token-reviewer" ||
			len(tokenBinding.Subjects) != 1 || tokenBinding.Subjects[0].Name != SessionServiceAccountName(test.session) {
			t.Fatalf("TokenReview binding is not exact: %#v", tokenBinding)
		}
	}
}

func TestSessionRequestsForHostOnlyEnqueuesAffectedSessions(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := clusterv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	objects := []client.Object{
		&clusterv1alpha1.T4Session{ObjectMeta: metav1.ObjectMeta{Name: "session-a", Namespace: "team"}, Spec: clusterv1alpha1.T4SessionSpec{HostRef: "host-a", WorkspaceRef: "workspace-a"}},
		&clusterv1alpha1.T4Session{ObjectMeta: metav1.ObjectMeta{Name: "session-b", Namespace: "team"}, Spec: clusterv1alpha1.T4SessionSpec{HostRef: "host-a", WorkspaceRef: "workspace-b"}},
		&clusterv1alpha1.T4Session{ObjectMeta: metav1.ObjectMeta{Name: "other-host", Namespace: "team"}, Spec: clusterv1alpha1.T4SessionSpec{HostRef: "host-b", WorkspaceRef: "workspace-a"}},
		&clusterv1alpha1.T4Session{ObjectMeta: metav1.ObjectMeta{Name: "other-namespace", Namespace: "other"}, Spec: clusterv1alpha1.T4SessionSpec{HostRef: "host-a", WorkspaceRef: "workspace-a"}},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).
		WithIndex(&clusterv1alpha1.T4Session{}, sessionHostRefIndexField, indexSessionByHostRef).
		WithIndex(&clusterv1alpha1.T4Session{}, sessionWorkspaceRefIndexField, indexSessionByWorkspaceRef).
		WithObjects(objects...).Build()
	r := &SessionReconciler{Client: c, Scheme: scheme}

	requests := r.sessionRequestsForHost(context.Background(), &clusterv1alpha1.T4ClusterHost{ObjectMeta: metav1.ObjectMeta{Name: "host-a", Namespace: "team"}})
	assertRequestSet(t, requests, []types.NamespacedName{
		{Namespace: "team", Name: "session-a"},
		{Namespace: "team", Name: "session-b"},
	})
}

func TestSessionRequestsForWorkspaceOnlyEnqueuesAffectedSessions(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := clusterv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	objects := []client.Object{
		&clusterv1alpha1.T4Session{ObjectMeta: metav1.ObjectMeta{Name: "session-a", Namespace: "team"}, Spec: clusterv1alpha1.T4SessionSpec{HostRef: "host-a", WorkspaceRef: "workspace-a"}},
		&clusterv1alpha1.T4Session{ObjectMeta: metav1.ObjectMeta{Name: "session-b", Namespace: "team"}, Spec: clusterv1alpha1.T4SessionSpec{HostRef: "host-b", WorkspaceRef: "workspace-a"}},
		&clusterv1alpha1.T4Session{ObjectMeta: metav1.ObjectMeta{Name: "other-workspace", Namespace: "team"}, Spec: clusterv1alpha1.T4SessionSpec{HostRef: "host-a", WorkspaceRef: "workspace-b"}},
		&clusterv1alpha1.T4Session{ObjectMeta: metav1.ObjectMeta{Name: "other-namespace", Namespace: "other"}, Spec: clusterv1alpha1.T4SessionSpec{HostRef: "host-a", WorkspaceRef: "workspace-a"}},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).
		WithIndex(&clusterv1alpha1.T4Session{}, sessionHostRefIndexField, indexSessionByHostRef).
		WithIndex(&clusterv1alpha1.T4Session{}, sessionWorkspaceRefIndexField, indexSessionByWorkspaceRef).
		WithObjects(objects...).Build()
	r := &SessionReconciler{Client: c, Scheme: scheme}

	requests := r.sessionRequestsForWorkspace(context.Background(), &clusterv1alpha1.T4Workspace{ObjectMeta: metav1.ObjectMeta{Name: "workspace-a", Namespace: "team"}})
	assertRequestSet(t, requests, []types.NamespacedName{
		{Namespace: "team", Name: "session-a"},
		{Namespace: "team", Name: "session-b"},
	})
}

func TestSessionLifecycleStatusDefaultsOnceAndIgnoresMetadataGeneration(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := clusterv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	session := &clusterv1alpha1.T4Session{
		ObjectMeta: metav1.ObjectMeta{Name: "legacy-session", Namespace: "team", UID: types.UID("stable-uid"), Generation: 7},
		Spec:       clusterv1alpha1.T4SessionSpec{HostRef: "host", WorkspaceRef: "workspace"},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Session{}).WithObjects(session).Build()
	reconciler := &SessionReconciler{Client: c}
	var stored clusterv1alpha1.T4Session
	if err := c.Get(t.Context(), client.ObjectKeyFromObject(session), &stored); err != nil {
		t.Fatal(err)
	}
	if err := reconciler.ensureSessionLifecycleStatus(t.Context(), &stored); err != nil {
		t.Fatal(err)
	}
	firstGeneration := stored.Status.RuntimeGeneration
	if !runtimeGenerationPattern.MatchString(firstGeneration) {
		t.Fatalf("generated runtime generation is not a bounded opaque token: %q", firstGeneration)
	}
	if got, want := stored.Status.CmuxSessionName, SessionCmuxName(&stored); got != want || len(got) > 63 {
		t.Fatalf("generated cmux session name = %q, want bounded deterministic %q", got, want)
	}
	firstFilesystemRoot := stored.Status.RuntimeStateFilesystemRoot
	if got, want := firstFilesystemRoot, RuntimeStateFilesystemRoot(&stored); got != want || len(got) > 63 {
		t.Fatalf("generated runtime-state filesystem root = %q, want bounded deterministic %q", got, want)
	}
	stored.Generation = 99
	stored.Status.RuntimeStateFilesystemRoot = "../../client-supplied-path"
	if err := reconciler.ensureSessionLifecycleStatus(t.Context(), &stored); err != nil {
		t.Fatal(err)
	}
	if stored.Status.RuntimeGeneration != firstGeneration {
		t.Fatalf("Kubernetes metadata generation changed runtime generation: %q -> %q", firstGeneration, stored.Status.RuntimeGeneration)
	}
	if stored.Status.RuntimeStateFilesystemRoot != firstFilesystemRoot {
		t.Fatalf("controller did not restore its deterministic runtime-state filesystem root: %q -> %q", firstFilesystemRoot, stored.Status.RuntimeStateFilesystemRoot)
	}
}

func TestSessionCmuxNameHonorsValidatedExplicitNameAndHasStableLegacyDefault(t *testing.T) {
	legacy := &clusterv1alpha1.T4Session{ObjectMeta: metav1.ObjectMeta{Name: "legacy-session", UID: types.UID("stable-uid")}}
	first := SessionCmuxName(legacy)
	legacy.Generation = 42
	if second := SessionCmuxName(legacy); first != second {
		t.Fatalf("default cmux name changed with Kubernetes generation: %q -> %q", first, second)
	}
	explicit := legacy.DeepCopy()
	explicit.Spec.CmuxSessionName = "Customer.Session-1"
	if got := SessionCmuxName(explicit); got != "Customer.Session-1" {
		t.Fatalf("explicit cmux session name was not preserved: %q", got)
	}
}

func TestRuntimeGenerationAllocationProducesDistinctOpaqueValues(t *testing.T) {
	first, err := newRuntimeGeneration()
	if err != nil {
		t.Fatal(err)
	}
	second, err := newRuntimeGeneration()
	if err != nil {
		t.Fatal(err)
	}
	if first == second || !runtimeGenerationPattern.MatchString(first) || !runtimeGenerationPattern.MatchString(second) {
		t.Fatalf("runtime generations must be distinct bounded opaque values: %q %q", first, second)
	}
}

func fenceTestScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	scheme := runtime.NewScheme()
	for _, add := range []func(*runtime.Scheme) error{
		clusterv1alpha1.AddToScheme,
		corev1.AddToScheme,
		coordinationv1.AddToScheme,
		rbacv1.AddToScheme,
		storagev1.AddToScheme,
	} {
		if err := add(scheme); err != nil {
			t.Fatal(err)
		}
	}
	return scheme
}

func TestFenceUncertainAttachmentNeverAdvancesGeneration(t *testing.T) {
	scheme := fenceTestScheme(t)
	pvName := "runtime-pv"
	session := &clusterv1alpha1.T4Session{
		ObjectMeta: metav1.ObjectMeta{Name: "session", Namespace: "team", UID: types.UID("session-uid"), Generation: 4},
		Status: clusterv1alpha1.T4SessionStatus{
			RuntimeGeneration: "gen_old-generation", FenceState: clusterv1alpha1.RuntimeFenceShutdownRequested,
			FencingGeneration: "gen_old-generation", RuntimeStatePVCName: "runtime-pvc",
			RuntimeStateVolumeIdentity: volumeIdentity(pvName), FencingVolumeIdentity: volumeIdentity(pvName),
		},
	}
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "runtime-pvc", Namespace: "team"},
		Spec:       corev1.PersistentVolumeClaimSpec{VolumeName: pvName},
	}
	attachment := &storagev1.VolumeAttachment{
		ObjectMeta: metav1.ObjectMeta{Name: "stale-attachment"},
		Spec: storagev1.VolumeAttachmentSpec{
			Attacher: "csi.example", NodeName: "lost-node",
			Source: storagev1.VolumeAttachmentSource{PersistentVolumeName: &pvName},
		},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Session{}).WithObjects(session, pvc, attachment).Build()
	r := &SessionReconciler{Client: c, APIReader: c, Scheme: scheme}
	var stored clusterv1alpha1.T4Session
	if err := c.Get(t.Context(), client.ObjectKeyFromObject(session), &stored); err != nil {
		t.Fatal(err)
	}
	prepared, err := r.prepareRunningGeneration(t.Context(), &stored, pvc)
	if err != nil {
		t.Fatal(err)
	}
	if prepared {
		t.Fatal("replacement was prepared with a stale VolumeAttachment")
	}
	if err := c.Get(t.Context(), client.ObjectKeyFromObject(session), &stored); err != nil {
		t.Fatal(err)
	}
	prepared, err = r.prepareRunningGeneration(t.Context(), &stored, pvc)
	if err != nil {
		t.Fatal(err)
	}
	if prepared {
		t.Fatal("replacement was prepared while fence evidence was uncertain")
	}
	if err := c.Get(t.Context(), client.ObjectKeyFromObject(session), &stored); err != nil {
		t.Fatal(err)
	}
	if stored.Status.RuntimeGeneration != "gen_old-generation" ||
		stored.Status.FenceState != clusterv1alpha1.RuntimeFenceUncertain ||
		stored.Status.Phase != clusterv1alpha1.InfrastructureDegraded {
		t.Fatalf("uncertain fence advanced or was not degraded: %#v", stored.Status)
	}
	if condition := meta.FindStatusCondition(stored.Status.Conditions, "Fenced"); condition == nil ||
		condition.Status != metav1.ConditionFalse || condition.Reason != "FenceUncertain" {
		t.Fatalf("missing fail-closed Fenced condition: %#v", stored.Status.Conditions)
	}
}
func TestPositiveNodeLossFenceAllocatesOneFreshGeneration(t *testing.T) {
	scheme := fenceTestScheme(t)
	pvName := "runtime-pv"
	session := &clusterv1alpha1.T4Session{
		ObjectMeta: metav1.ObjectMeta{Name: "session", Namespace: "team", UID: types.UID("session-uid"), Generation: 4},
		Status: clusterv1alpha1.T4SessionStatus{
			RuntimeGeneration: "gen_old-generation", FenceState: clusterv1alpha1.RuntimeFenceVerifying,
			FencingGeneration: "gen_old-generation", FencingPodUID: "pod-on-lost-node",
			RuntimeStatePVCName: "runtime-pvc", RuntimeStateVolumeIdentity: volumeIdentity(pvName),
			FencingVolumeIdentity: volumeIdentity(pvName),
		},
	}
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "runtime-pvc", Namespace: session.Namespace},
		Spec:       corev1.PersistentVolumeClaimSpec{VolumeName: pvName},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Session{}).WithObjects(session, pvc).Build()
	r := &SessionReconciler{Client: c, APIReader: c, Scheme: scheme}
	var stored clusterv1alpha1.T4Session
	if err := c.Get(t.Context(), client.ObjectKeyFromObject(session), &stored); err != nil {
		t.Fatal(err)
	}
	prepared, err := r.prepareRunningGeneration(t.Context(), &stored, pvc)
	if err != nil || !prepared {
		t.Fatalf("positive fence did not prepare replacement: prepared=%t err=%v", prepared, err)
	}
	if err := c.Get(t.Context(), client.ObjectKeyFromObject(session), &stored); err != nil {
		t.Fatal(err)
	}
	freshGeneration := stored.Status.RuntimeGeneration
	if freshGeneration == "gen_old-generation" || stored.Status.FenceState != clusterv1alpha1.RuntimeFenceProven ||
		stored.Status.FencingGeneration != "" || stored.Status.FencingPodUID != "" || stored.Status.FencingVolumeIdentity != "" {
		t.Fatalf("positive fence did not commit one fresh generation: %#v", stored.Status)
	}
	prepared, err = r.prepareRunningGeneration(t.Context(), &stored, pvc)
	if err != nil || !prepared {
		t.Fatalf("committed replacement generation was not stable: prepared=%t err=%v", prepared, err)
	}
	if stored.Status.RuntimeGeneration != freshGeneration {
		t.Fatalf("replacement generation advanced twice: %q -> %q", freshGeneration, stored.Status.RuntimeGeneration)
	}
}

func TestFenceProofUsesRecordedVolumeIdentityAfterPVCReplacement(t *testing.T) {
	scheme := fenceTestScheme(t)
	oldVolumeName := "runtime-pv-old"
	session := &clusterv1alpha1.T4Session{
		ObjectMeta: metav1.ObjectMeta{Name: "session", Namespace: "team", UID: types.UID("session-uid")},
		Status: clusterv1alpha1.T4SessionStatus{
			RuntimeGeneration: "gen_old-generation", FenceState: clusterv1alpha1.RuntimeFenceProven,
			PodName: "missing-pod", PodUID: "pod-old", RuntimeStatePVCName: "runtime-pvc",
			RuntimeStateVolumeIdentity: volumeIdentity(oldVolumeName),
		},
	}
	replacementPVC := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "runtime-pvc", Namespace: session.Namespace},
		Status:     corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimPending},
	}
	attachment := &storagev1.VolumeAttachment{
		ObjectMeta: metav1.ObjectMeta{Name: "old-attachment"},
		Spec: storagev1.VolumeAttachmentSpec{
			Attacher: "csi.example", NodeName: "lost-node",
			Source: storagev1.VolumeAttachmentSource{PersistentVolumeName: &oldVolumeName},
		},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Session{}).WithObjects(session, attachment).Build()
	r := &SessionReconciler{Client: c, APIReader: c}
	var stored clusterv1alpha1.T4Session
	if err := c.Get(t.Context(), client.ObjectKeyFromObject(session), &stored); err != nil {
		t.Fatal(err)
	}
	if err := r.updateRuntimeStateStatus(t.Context(), &stored, replacementPVC); err != nil {
		t.Fatal(err)
	}
	if stored.Status.RuntimeStateVolumeIdentity != volumeIdentity(oldVolumeName) {
		t.Fatal("Pending replacement PVC cleared the recorded old volume identity")
	}
	if err := r.beginGenerationDrain(t.Context(), &stored, &corev1.Pod{}, &corev1.Service{}, "RuntimeLost", "old workload is absent"); err != nil {
		t.Fatal(err)
	}
	if stored.Status.FencingVolumeIdentity != volumeIdentity(oldVolumeName) {
		t.Fatal("drain did not retain the old volume identity")
	}
	if err := r.enterFenceVerifying(t.Context(), &stored); err != nil {
		t.Fatal(err)
	}
	proven, reason, _, err := r.positiveFenceProof(t.Context(), &stored, replacementPVC)
	if err != nil || proven || reason != "VolumeAttachmentUncertain" {
		t.Fatalf("replacement PVC hid old attachment: proven=%t reason=%q err=%v", proven, reason, err)
	}
}

func TestNoPriorWriterPositivelyFencesWithoutAllocatedStorage(t *testing.T) {
	scheme := fenceTestScheme(t)
	session := &clusterv1alpha1.T4Session{
		ObjectMeta: metav1.ObjectMeta{Name: "session", Namespace: "team", UID: types.UID("session-uid")},
		Status: clusterv1alpha1.T4SessionStatus{
			RuntimeGeneration:   "gen_initial-generation",
			FenceState:          clusterv1alpha1.RuntimeFenceNoPriorWriter,
			FencingGeneration:   "gen_initial-generation",
			RuntimeStatePVCName: "runtime-pvc",
		},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(session).Build()
	r := &SessionReconciler{Client: c, APIReader: c}
	proven, reason, _, err := r.positiveFenceProof(t.Context(), session, &corev1.PersistentVolumeClaim{})
	if err != nil || !proven || reason != "FenceProven" {
		t.Fatalf("no-prior-writer proof = proven=%t reason=%q err=%v", proven, reason, err)
	}
}

func TestNoPriorWriterWithBoundPVCPositivelyFencesAfterRestart(t *testing.T) {
	scheme := fenceTestScheme(t)
	pvName := "runtime-pv"
	session := &clusterv1alpha1.T4Session{
		ObjectMeta: metav1.ObjectMeta{Name: "session", Namespace: "team", UID: types.UID("session-uid")},
		Status: clusterv1alpha1.T4SessionStatus{
			RuntimeGeneration: "gen_initial-generation", FenceState: clusterv1alpha1.RuntimeFenceNoPriorWriter,
			FencingGeneration: "gen_initial-generation", RuntimeStatePVCName: "runtime-pvc",
			RuntimeStateVolumeIdentity: volumeIdentity(pvName),
		},
	}
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "runtime-pvc", Namespace: session.Namespace},
		Spec:       corev1.PersistentVolumeClaimSpec{VolumeName: pvName},
		Status:     corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(session, pvc).Build()
	restarted := &SessionReconciler{Client: c, APIReader: c}
	proven, reason, _, err := restarted.positiveFenceProof(t.Context(), session, pvc)
	if err != nil || !proven || reason != "FenceProven" {
		t.Fatalf("bound PVC on never-started session blocked first start after restart: proven=%t reason=%q err=%v", proven, reason, err)
	}
}

func TestGenerationStatusCASConflictCreatesNoCredentialOrPod(t *testing.T) {
	scheme := fenceTestScheme(t)
	session := &clusterv1alpha1.T4Session{
		ObjectMeta: metav1.ObjectMeta{Name: "session", Namespace: "team", UID: types.UID("session-uid"), Generation: 2},
		Status:     clusterv1alpha1.T4SessionStatus{RuntimeGeneration: "gen_old-generation", FenceState: clusterv1alpha1.RuntimeFenceNoPriorWriter},
	}
	pvc := &corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Name: "runtime-pvc", Namespace: "team"}}
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Session{}).WithObjects(session, pvc).Build()
	r := &SessionReconciler{Client: c, APIReader: c, Scheme: scheme}
	var stale, winner clusterv1alpha1.T4Session
	if err := c.Get(t.Context(), client.ObjectKeyFromObject(session), &stale); err != nil {
		t.Fatal(err)
	}
	if err := c.Get(t.Context(), client.ObjectKeyFromObject(session), &winner); err != nil {
		t.Fatal(err)
	}
	winner.Status.Phase = clusterv1alpha1.InfrastructurePending
	if err := c.Status().Update(t.Context(), &winner); err != nil {
		t.Fatal(err)
	}
	if _, err := r.prepareRunningGeneration(t.Context(), &stale, pvc); !apierrors.IsConflict(err) {
		t.Fatalf("stale generation CAS error = %v, want conflict", err)
	}
	var secrets corev1.SecretList
	if err := c.List(t.Context(), &secrets, client.InNamespace("team")); err != nil {
		t.Fatal(err)
	}
	var pods corev1.PodList
	if err := c.List(t.Context(), &pods, client.InNamespace("team")); err != nil {
		t.Fatal(err)
	}
	if len(secrets.Items) != 0 || len(pods.Items) != 0 {
		t.Fatalf("CAS loser created resources: secrets=%d pods=%d", len(secrets.Items), len(pods.Items))
	}
}

func TestExistingCurrentGenerationStartupDoesNotTriggerReplacement(t *testing.T) {
	scheme := fenceTestScheme(t)
	generation := "gen_current-generation"
	session := &clusterv1alpha1.T4Session{
		ObjectMeta: metav1.ObjectMeta{Name: "session", Namespace: "team", UID: types.UID("session-uid"), Generation: 2},
		Status: clusterv1alpha1.T4SessionStatus{
			RuntimeGeneration: generation, GenerationSecretEpoch: generation,
			FenceState: clusterv1alpha1.RuntimeFenceProven,
		},
	}
	session.Status.GenerationSecretName = GenerationAuthSecretName(session, generation)
	controller := true
	owner := metav1.OwnerReference{APIVersion: clusterv1alpha1.GroupVersion.String(), Kind: "T4Session", Name: session.Name, UID: session.UID, Controller: &controller}
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: SessionPodName(session), Namespace: session.Namespace, UID: types.UID("current-pod"), OwnerReferences: []metav1.OwnerReference{owner}}}
	immutable := true
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name: session.Status.GenerationSecretName, Namespace: session.Namespace,
			Annotations:     map[string]string{"cluster.t4.dev/runtime-generation": generation},
			OwnerReferences: []metav1.OwnerReference{owner},
		},
		Immutable: &immutable,
		Type:      corev1.SecretTypeOpaque,
		Data:      map[string][]byte{generationAuthKey: make([]byte, 32)},
	}
	pvc := &corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Name: "runtime-pvc", Namespace: session.Namespace}}
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Session{}).WithObjects(session, pod, secret, pvc).Build()
	r := &SessionReconciler{Client: c, APIReader: c, Scheme: scheme}
	prepared, err := r.prepareRunningGeneration(t.Context(), session, pvc)
	if err != nil || !prepared {
		t.Fatalf("existing current generation was replaced: prepared=%t err=%v", prepared, err)
	}
	var retained corev1.Pod
	if err := c.Get(t.Context(), client.ObjectKeyFromObject(pod), &retained); err != nil || !retained.DeletionTimestamp.IsZero() {
		t.Fatalf("existing current Pod was drained: pod=%#v err=%v", retained, err)
	}
}

func TestDrainRetractsRouteAndRevokesCredentialBeforePodRemoval(t *testing.T) {
	scheme := fenceTestScheme(t)
	session := &clusterv1alpha1.T4Session{
		ObjectMeta: metav1.ObjectMeta{Name: "session", Namespace: "team", UID: types.UID("session-uid"), Generation: 3},
		Status: clusterv1alpha1.T4SessionStatus{
			RuntimeGeneration: "gen_current-generation", GenerationSecretEpoch: "gen_current-generation",
			GenerationSecretName: "generation-secret", ServiceName: "session-service", PodName: "session-pod",
		},
	}
	controller := true
	owner := metav1.OwnerReference{APIVersion: clusterv1alpha1.GroupVersion.String(), Kind: "T4Session", Name: session.Name, UID: session.UID, Controller: &controller}
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "session-pod", Namespace: "team", UID: types.UID("pod-old"), OwnerReferences: []metav1.OwnerReference{owner}}}
	service := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "session-service", Namespace: "team", OwnerReferences: []metav1.OwnerReference{owner}}, Spec: corev1.ServiceSpec{Selector: map[string]string{"route": "live"}}}
	secret := &corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: "generation-secret", Namespace: "team", OwnerReferences: []metav1.OwnerReference{owner}}}
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Session{}).WithObjects(session, pod, service, secret).Build()
	r := &SessionReconciler{Client: c, APIReader: c, Scheme: scheme}
	var stored clusterv1alpha1.T4Session
	if err := c.Get(t.Context(), client.ObjectKeyFromObject(session), &stored); err != nil {
		t.Fatal(err)
	}
	if err := r.beginGenerationDrain(t.Context(), &stored, pod, service, "Replacement", "replacement requested"); err != nil {
		t.Fatal(err)
	}
	if err := c.Get(t.Context(), client.ObjectKeyFromObject(service), service); err != nil {
		t.Fatal(err)
	}
	if len(service.Spec.Selector) != 0 {
		t.Fatalf("route remained published: %#v", service.Spec.Selector)
	}
	if err := c.Get(t.Context(), client.ObjectKey{Namespace: "team", Name: "generation-secret"}, &corev1.Secret{}); !apierrors.IsNotFound(err) {
		t.Fatalf("generation Secret was not revoked: %v", err)
	}
	if err := c.Get(t.Context(), client.ObjectKeyFromObject(pod), &corev1.Pod{}); !apierrors.IsNotFound(err) {
		t.Fatalf("old Pod was not removed after revocation: %v", err)
	}
	if err := c.Get(t.Context(), client.ObjectKeyFromObject(session), &stored); err != nil {
		t.Fatal(err)
	}
	for _, conditionType := range []string{"RouteReady", "TicketsRevoked", "GenerationAuthRevoked"} {
		condition := meta.FindStatusCondition(stored.Status.Conditions, conditionType)
		if condition == nil || conditionType == "RouteReady" && condition.Status != metav1.ConditionFalse ||
			conditionType != "RouteReady" && condition.Status != metav1.ConditionTrue {
			t.Fatalf("ordered drain condition %s missing: %#v", conditionType, stored.Status.Conditions)
		}
	}
}

func TestCompositeReadinessNeverPublishesBeforeProbeAndAuthorities(t *testing.T) {
	scheme := fenceTestScheme(t)
	generation := "gen_current-generation"
	session := &clusterv1alpha1.T4Session{
		ObjectMeta: metav1.ObjectMeta{Name: "session", Namespace: "team", UID: types.UID("session-uid"), ResourceVersion: "1"},
		Spec:       clusterv1alpha1.T4SessionSpec{DesiredState: clusterv1alpha1.DesiredStateRunning, GUIEnabled: true},
		Status:     clusterv1alpha1.T4SessionStatus{RuntimeGeneration: generation},
	}
	controller := true
	owner := metav1.OwnerReference{APIVersion: clusterv1alpha1.GroupVersion.String(), Kind: "T4Session", Name: session.Name, UID: session.UID, Controller: &controller}
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: "session-pod", Namespace: "team", UID: types.UID("pod-current"), OwnerReferences: []metav1.OwnerReference{owner}, Annotations: map[string]string{clusterv1alpha1.SessionPodSpecHashAnnotation: "current"}},
		Status: corev1.PodStatus{Phase: corev1.PodRunning, Conditions: []corev1.PodCondition{
			{Type: corev1.PodReady, Status: corev1.ConditionTrue},
			{Type: corev1.PodScheduled, Status: corev1.ConditionTrue},
		}},
	}
	pvc := &corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Name: "runtime-pvc", Namespace: "team", UID: types.UID("pvc-current"), OwnerReferences: []metav1.OwnerReference{owner}}, Status: corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound}}
	holder := string(pod.UID)
	lease := &coordinationv1.Lease{ObjectMeta: metav1.ObjectMeta{Name: SessionWriterLeaseName(session), Namespace: "team", Annotations: map[string]string{writerLeaseGenerationAnnotation: generation}, OwnerReferences: []metav1.OwnerReference{owner}}, Spec: coordinationv1.LeaseSpec{HolderIdentity: &holder}}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(session, pod, pvc, lease).Build()
	r := &SessionReconciler{Client: c, APIReader: c}
	ready, reason, _, err := r.compositeRuntimeReady(t.Context(), session, pod, pvc)
	if err != nil || !ready {
		t.Fatalf("complete probe-backed readiness rejected: ready=%t reason=%s err=%v", ready, reason, err)
	}
	var authoritativePod corev1.Pod
	if err := c.Get(t.Context(), client.ObjectKeyFromObject(pod), &authoritativePod); err != nil {
		t.Fatal(err)
	}
	authoritativePod.Status.Conditions[0].Status = corev1.ConditionFalse
	if err := c.Status().Update(t.Context(), &authoritativePod); err != nil {
		t.Fatal(err)
	}
	ready, reason, _, err = r.compositeRuntimeReady(t.Context(), session, pod, pvc)
	if err != nil || ready || reason != "PodNotReady" {
		t.Fatalf("stale cached Ready Pod published route over authoritative NotReady Pod: ready=%t reason=%s err=%v", ready, reason, err)
	}
	authoritativePod.Status.Conditions[0].Status = corev1.ConditionTrue
	if err := c.Status().Update(t.Context(), &authoritativePod); err != nil {
		t.Fatal(err)
	}
	var authoritativePVC corev1.PersistentVolumeClaim
	if err := c.Get(t.Context(), client.ObjectKeyFromObject(pvc), &authoritativePVC); err != nil {
		t.Fatal(err)
	}
	authoritativePVC.Status.Phase = corev1.ClaimLost
	if err := c.Status().Update(t.Context(), &authoritativePVC); err != nil {
		t.Fatal(err)
	}
	ready, reason, _, err = r.compositeRuntimeReady(t.Context(), session, pod, pvc)
	if err != nil || ready || reason != "StorageNotReady" {
		t.Fatalf("stale cached Bound PVC published route over authoritative Lost PVC: ready=%t reason=%s err=%v", ready, reason, err)
	}
	authoritativePVC.Status.Phase = corev1.ClaimBound
	if err := c.Status().Update(t.Context(), &authoritativePVC); err != nil {
		t.Fatal(err)
	}
	lease.Annotations[writerLeaseGenerationAnnotation] = "gen_stale-generation"
	if err := c.Update(t.Context(), lease); err != nil {
		t.Fatal(err)
	}
	ready, reason, _, err = r.compositeRuntimeReady(t.Context(), session, pod, pvc)
	if err != nil || ready || reason != "WriterLeaseNotReady" {
		t.Fatalf("stale-generation Lease published route: ready=%t reason=%s err=%v", ready, reason, err)
	}
}

func TestSessionPodUsesSeparateCompositeExecProbes(t *testing.T) {
	session := &clusterv1alpha1.T4Session{
		ObjectMeta: metav1.ObjectMeta{Name: "session", Namespace: "team", UID: types.UID("session-uid")},
		Status: clusterv1alpha1.T4SessionStatus{
			RuntimeGeneration:          "gen_current-generation",
			RuntimeStateFilesystemRoot: "runtime-session",
			CmuxSessionName:            "session",
			GenerationSecretName:       "generation-auth",
		},
	}
	r := &SessionReconciler{RuntimeImage: "registry.example/runtime@sha256:" + strings.Repeat("a", 64)}
	pod, err := r.desiredPod(session, "workspace-pvc", "runtime-pvc", "session-pod", map[string]string{"app": "runtime"}, ompResourceVersions{})
	if err != nil {
		t.Fatal(err)
	}
	authority := pod.Spec.Containers[0]
	for name, probe := range map[string]*corev1.Probe{"startup": authority.StartupProbe, "readiness": authority.ReadinessProbe, "liveness": authority.LivenessProbe} {
		if probe == nil || probe.Exec == nil || len(probe.Exec.Command) != 2 || probe.Exec.Command[1] != "/usr/local/lib/t4/session-authority-health.js" {
			t.Fatalf("authority %s probe is not authority-specific: %#v", name, probe)
		}
	}
	shell := pod.Spec.Containers[1]
	for kind, probe := range map[string]*corev1.Probe{"startup": shell.StartupProbe, "readiness": shell.ReadinessProbe, "liveness": shell.LivenessProbe} {
		if probe == nil || probe.Exec == nil || len(probe.Exec.Command) != 4 || probe.Exec.Command[2] != kind || probe.Exec.Command[3] != "shell" {
			t.Fatalf("shell %s probe is not the dedicated shell exec probe: %#v", kind, probe)
		}
	}
	if len(pod.Spec.ReadinessGates) != 0 {
		t.Fatalf("unpublished custom readiness gates still block kubelet readiness: %#v", pod.Spec.ReadinessGates)
	}
	for _, name := range []string{"T4_WRITER_LEASE_NAME", "POD_UID", "T4_GENERATION_AUTH_PATH", "T4_KUBERNETES_TOKEN_PATH"} {
		authorityHas, shellHas, credentialHas := false, false, false
		for _, variable := range pod.Spec.Containers[0].Env {
			authorityHas = authorityHas || variable.Name == name
		}
		for _, variable := range pod.Spec.Containers[1].Env {
			shellHas = shellHas || variable.Name == name
		}
		for _, variable := range pod.Spec.Containers[2].Env {
			credentialHas = credentialHas || variable.Name == name
		}
		if authorityHas || shellHas || !credentialHas {
			t.Fatalf("%s projection authority=%t shell=%t credential=%t, want credential-only", name, authorityHas, shellHas, credentialHas)
		}
	}
	for _, container := range pod.Spec.Containers[:2] {
		for _, mount := range container.VolumeMounts {
			if mount.Name == "kubernetes-api-access" || mount.Name == "generation-auth" {
				t.Fatalf("%s received credential mount %#v", container.Name, mount)
			}
		}
	}
}

func TestSessionPodBrowserPolicyControlsBothRuntimeContainers(t *testing.T) {
	session := &clusterv1alpha1.T4Session{
		ObjectMeta: metav1.ObjectMeta{Name: "session", Namespace: "team", UID: types.UID("session-uid")},
		Spec:       clusterv1alpha1.T4SessionSpec{GUIEnabled: true, BrowserPolicy: clusterv1alpha1.BrowserPolicyDisabled},
		Status: clusterv1alpha1.T4SessionStatus{
			RuntimeGeneration:          "gen_current-generation",
			RuntimeStateFilesystemRoot: "runtime-session",
			CmuxSessionName:            "session",
			GenerationSecretName:       "generation-auth",
		},
	}
	r := &SessionReconciler{RuntimeImage: "registry.example/runtime@sha256:" + strings.Repeat("a", 64)}
	assertBrowserEnv := func(want string) {
		pod, err := r.desiredPod(session, "workspace-pvc", "runtime-pvc", "session-pod", map[string]string{"app": "runtime"}, ompResourceVersions{})
		if err != nil {
			t.Fatal(err)
		}
		for _, container := range pod.Spec.Containers[:2] {
			found := false
			for _, variable := range container.Env {
				if variable.Name == "T4_GUI_ENABLED" {
					found = true
					if variable.Value != want {
						t.Fatalf("%s T4_GUI_ENABLED = %q, want %q", container.Name, variable.Value, want)
					}
				}
			}
			if !found {
				t.Fatalf("%s does not project T4_GUI_ENABLED", container.Name)
			}
		}
	}
	assertBrowserEnv("false")
	session.Spec.BrowserPolicy = clusterv1alpha1.BrowserPolicyAllowed
	session.Spec.GUIEnabled = false
	assertBrowserEnv("true")
}

func TestGenerationAuthSecretsAreUniqueAndGenerationBound(t *testing.T) {
	session := &clusterv1alpha1.T4Session{ObjectMeta: metav1.ObjectMeta{Name: "session", UID: types.UID("session-uid")}}
	first := GenerationAuthSecretName(session, "gen_first-generation")
	second := GenerationAuthSecretName(session, "gen_second-generation")
	if first == second || len(first) > 63 || len(second) > 63 {
		t.Fatalf("generation Secret names are not distinct and bounded: %q %q", first, second)
	}
}

func TestFenceProofRejectsStaleWriterLease(t *testing.T) {
	scheme := fenceTestScheme(t)
	session := &clusterv1alpha1.T4Session{
		ObjectMeta: metav1.ObjectMeta{Name: "session", Namespace: "team", UID: types.UID("session-uid")},
		Status: clusterv1alpha1.T4SessionStatus{
			RuntimeGeneration: "gen_old-generation", FenceState: clusterv1alpha1.RuntimeFenceVerifying,
			FencingGeneration: "gen_old-generation", FencingPodUID: "pod-old",
			FencingVolumeIdentity: volumeIdentity("runtime-pv"),
		},
	}
	holder := "pod-old"
	lease := &coordinationv1.Lease{
		ObjectMeta: metav1.ObjectMeta{Name: SessionWriterLeaseName(session), Namespace: session.Namespace},
		Spec:       coordinationv1.LeaseSpec{HolderIdentity: &holder},
	}
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: "runtime-pvc", Namespace: session.Namespace},
		Spec:       corev1.PersistentVolumeClaimSpec{VolumeName: "runtime-pv"},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithObjects(lease).Build()
	r := &SessionReconciler{Client: c, APIReader: c}
	proven, reason, _, err := r.positiveFenceProof(t.Context(), session, pvc)
	if err != nil || proven || reason != "WriterLeaseUncertain" {
		t.Fatalf("stale writer Lease was accepted: proven=%t reason=%s err=%v", proven, reason, err)
	}
}

func TestInactiveMissingPodStillDrainsOwnedGenerationAuthority(t *testing.T) {
	scheme := fenceTestScheme(t)
	generation := "gen_active-generation"
	session := &clusterv1alpha1.T4Session{
		ObjectMeta: metav1.ObjectMeta{Name: "session", Namespace: "team", UID: types.UID("session-uid"), Generation: 4},
		Status: clusterv1alpha1.T4SessionStatus{
			RuntimeGeneration: generation, GenerationSecretEpoch: generation,
			GenerationSecretName: "generation-auth", FenceState: clusterv1alpha1.RuntimeFenceProven,
			PodName: SessionPodName(&clusterv1alpha1.T4Session{ObjectMeta: metav1.ObjectMeta{Name: "session", UID: types.UID("session-uid")}}),
			PodUID:  "missing-pod", RuntimeStatePVCName: "runtime-pvc",
		},
	}
	controller := true
	owner := metav1.OwnerReference{APIVersion: clusterv1alpha1.GroupVersion.String(), Kind: "T4Session", Name: session.Name, UID: session.UID, Controller: &controller}
	service := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: SessionServiceName(session), Namespace: session.Namespace, OwnerReferences: []metav1.OwnerReference{owner}},
		Spec:       corev1.ServiceSpec{Selector: map[string]string{"route": "active"}},
	}
	immutable := true
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: session.Status.GenerationSecretName, Namespace: session.Namespace, OwnerReferences: []metav1.OwnerReference{owner}},
		Immutable:  &immutable,
	}
	holder := session.Status.PodUID
	lease := &coordinationv1.Lease{
		ObjectMeta: metav1.ObjectMeta{Name: SessionWriterLeaseName(session), Namespace: session.Namespace, OwnerReferences: []metav1.OwnerReference{owner}},
		Spec:       coordinationv1.LeaseSpec{HolderIdentity: &holder},
	}
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: session.Status.RuntimeStatePVCName, Namespace: session.Namespace},
		Spec:       corev1.PersistentVolumeClaimSpec{VolumeName: "runtime-pv"},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Session{}).WithObjects(session, service, secret, lease, pvc).Build()
	r := &SessionReconciler{Client: c, APIReader: c, Scheme: scheme}
	var stored clusterv1alpha1.T4Session
	if err := c.Get(t.Context(), client.ObjectKeyFromObject(session), &stored); err != nil {
		t.Fatal(err)
	}
	if _, err := r.reconcileInactive(t.Context(), &stored, clusterv1alpha1.DesiredStateSleeping); err != nil {
		t.Fatal(err)
	}
	if err := c.Get(t.Context(), client.ObjectKeyFromObject(service), service); err != nil || len(service.Spec.Selector) != 0 {
		t.Fatalf("owned route was not withdrawn: selector=%#v err=%v", service.Spec.Selector, err)
	}
	if err := c.Get(t.Context(), client.ObjectKeyFromObject(secret), &corev1.Secret{}); !apierrors.IsNotFound(err) {
		t.Fatalf("owned generation authentication was not revoked: %v", err)
	}
	if err := c.Get(t.Context(), client.ObjectKeyFromObject(session), &stored); err != nil {
		t.Fatal(err)
	}
	if stored.Status.FencingVolumeIdentity != volumeIdentity("runtime-pv") {
		t.Fatal("legacy live status did not capture the authoritative volume identity before drain")
	}
	if _, err := r.reconcileInactive(t.Context(), &stored, clusterv1alpha1.DesiredStateSleeping); err != nil {
		t.Fatal(err)
	}
	if err := c.Get(t.Context(), client.ObjectKeyFromObject(lease), &coordinationv1.Lease{}); !apierrors.IsNotFound(err) {
		t.Fatalf("owned writer Lease was not revoked during verification: %v", err)
	}
	if err := c.Get(t.Context(), client.ObjectKeyFromObject(session), &stored); err != nil {
		t.Fatal(err)
	}
	if stored.Status.Phase != clusterv1alpha1.InfrastructureSleeping || stored.Status.FenceState != clusterv1alpha1.RuntimeFenceProven {
		t.Fatalf("inactive authority did not converge through positive fence proof: %#v", stored.Status)
	}
}
