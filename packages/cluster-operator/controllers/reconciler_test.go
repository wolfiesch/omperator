package controllers_test

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	coordinationv1 "k8s.io/api/coordination/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	storagev1 "k8s.io/api/storage/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apiresource "k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/api/meta"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	clusterv1alpha1 "github.com/wolfiesch/omperator/packages/cluster-operator/api/v1alpha1"
	"github.com/wolfiesch/omperator/packages/cluster-operator/controllers"
)

const (
	testRuntimeImage      = "registry.example/session@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	otherTestRuntimeImage = "registry.example/session@sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"
	testOMPModels         = "providers:\n  isolated:\n    baseUrl: http://model-route.example/v1\n    api: openai-completions\n    auth: none\n    models:\n      - id: test\n"
	otherTestOMPModels    = "providers:\n  isolated-v2:\n    baseUrl: http://model-route.example/v2\n    api: openai-completions\n    auth: none\n    models:\n      - id: test-v2\n"
	testOMPSettings       = "theme: dark\n"
	otherTestOMPSettings  = "theme: light\n"
)

const testWorkspaceSessionRefIndexField = "t4.workspace.session.spec.workspaceRef"

func testIndexWorkspaceSessionByWorkspaceRef(object client.Object) []string {
	session, ok := object.(*clusterv1alpha1.T4Session)
	if !ok || session.Spec.WorkspaceRef == "" {
		return nil
	}
	return []string{session.Spec.WorkspaceRef}
}

func TestWorkspaceReconcileIsIdempotentAcrossDuplicateEvents(t *testing.T) {
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
	c := fake.NewClientBuilder().WithScheme(scheme).
		WithIndex(&clusterv1alpha1.T4Session{}, testWorkspaceSessionRefIndexField, testIndexWorkspaceSessionByWorkspaceRef).
		WithStatusSubresource(&clusterv1alpha1.T4ClusterHost{}, &clusterv1alpha1.T4Workspace{}, &clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
		WithObjects(testHost(), rwxStorageClass(), workspace).Build()
	r := &controllers.WorkspaceReconciler{Client: c, Scheme: scheme}
	reconcileMany(t, 4, func() error {
		_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(workspace)})
		return err
	})

	var pvcs corev1.PersistentVolumeClaimList
	if err := c.List(context.Background(), &pvcs, client.InNamespace("team")); err != nil {
		t.Fatal(err)
	}
	if len(pvcs.Items) != 1 {
		t.Fatalf("duplicate events created %d PVCs, want 1", len(pvcs.Items))
	}
	pvc := pvcs.Items[0]
	if len(pvc.Spec.AccessModes) != 1 || pvc.Spec.AccessModes[0] != corev1.ReadWriteMany {
		t.Fatalf("PVC access modes = %v, want only ReadWriteMany", pvc.Spec.AccessModes)
	}
	if pvc.Spec.StorageClassName == nil || *pvc.Spec.StorageClassName != "portable-rwx" {
		t.Fatalf("PVC storage class = %v", pvc.Spec.StorageClassName)
	}

	var got clusterv1alpha1.T4Workspace
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(workspace), &got); err != nil {
		t.Fatal(err)
	}
	if got.Status.ObservedGeneration != got.Generation || got.Status.PVCName != pvc.Name ||
		got.Status.SelectedStorageClassName != "portable-rwx" ||
		got.Status.FilesystemRoot != controllers.WorkspaceFilesystemRoot(&got) ||
		got.Status.AttachmentCount == nil || *got.Status.AttachmentCount != 0 {
		t.Fatalf("workspace bounded infrastructure status not converged: %#v", got.Status)
	}
	if !contains(got.Finalizers, clusterv1alpha1.WorkspaceFinalizer) {
		t.Fatal("workspace protection finalizer missing")
	}
}

func TestWorkspaceStorageSelectionStaysWithinHostBoundWhileRuntimeStateClassDiffers(t *testing.T) {
	ctx := context.Background()
	scheme := testScheme(t)
	host := testHost()
	host.Spec.RuntimeStateStorageProfile = &clusterv1alpha1.RuntimeStateStorageProfile{
		StorageClassName: "runtime-rwo",
		Size:             apiresource.MustParse("8Gi"),
	}
	runtimeClass := &storagev1.StorageClass{
		ObjectMeta:  metav1.ObjectMeta{Name: "runtime-rwo"},
		Provisioner: "example.invalid/csi",
	}
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
	workspace.Spec.StorageClassName = "portable-rwx"
	c := fake.NewClientBuilder().WithScheme(scheme).
		WithIndex(&clusterv1alpha1.T4Session{}, testWorkspaceSessionRefIndexField, testIndexWorkspaceSessionByWorkspaceRef).
		WithStatusSubresource(&clusterv1alpha1.T4Workspace{}, &corev1.PersistentVolumeClaim{}).
		WithObjects(host, rwxStorageClass(), runtimeClass, workspace).Build()
	reconciler := &controllers.WorkspaceReconciler{Client: c, Scheme: scheme}
	reconcileMany(t, 3, func() error {
		_, err := reconciler.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(workspace)})
		return err
	})
	var pvc corev1.PersistentVolumeClaim
	if err := c.Get(ctx, types.NamespacedName{Namespace: workspace.Namespace, Name: controllers.WorkspacePVCName(workspace)}, &pvc); err != nil {
		t.Fatal(err)
	}
	if pvc.Spec.StorageClassName == nil || *pvc.Spec.StorageClassName != "portable-rwx" {
		t.Fatalf("workspace PVC used runtime-state StorageClass: %#v", pvc.Spec.StorageClassName)
	}

	outside := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
	outside.Name = "outside-bound"
	outside.UID = "outside-bound-uid"
	outside.Spec.StorageClassName = "runtime-rwo"
	if err := c.Create(ctx, outside); err != nil {
		t.Fatal(err)
	}
	if _, err := reconciler.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(outside)}); err != nil {
		t.Fatal(err)
	}
	var rejected clusterv1alpha1.T4Workspace
	if err := c.Get(ctx, client.ObjectKeyFromObject(outside), &rejected); err != nil {
		t.Fatal(err)
	}
	condition := findCondition(rejected.Status.Conditions, "StorageReady")
	if condition == nil || condition.Status != metav1.ConditionFalse || condition.Reason != controllers.ReasonStorageClassMismatch {
		t.Fatalf("outside-bound workspace StorageClass was not rejected: %#v", rejected.Status)
	}
	var forbiddenPVC corev1.PersistentVolumeClaim
	if err := c.Get(ctx, types.NamespacedName{Namespace: outside.Namespace, Name: controllers.WorkspacePVCName(outside)}, &forbiddenPVC); !apierrors.IsNotFound(err) {
		t.Fatalf("outside-bound selection created or resolved a PVC: %v", err)
	}
}

func TestHostRuntimeStateStorageFailsClosedWithoutConformanceProof(t *testing.T) {
	ctx := context.Background()
	scheme := testScheme(t)
	host := testHost()
	host.Spec.RuntimeStateStorageProfile = &clusterv1alpha1.RuntimeStateStorageProfile{
		StorageClassName:        "runtime-rwo",
		Size:                    apiresource.MustParse("8Gi"),
		VolumeSnapshotClassName: "optional-csi-snapshots",
	}
	runtimeClass := &storagev1.StorageClass{
		ObjectMeta:  metav1.ObjectMeta{Name: "runtime-rwo"},
		Provisioner: "example.invalid/csi",
	}
	c := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(&clusterv1alpha1.T4ClusterHost{}).
		WithObjects(host, rwxStorageClass(), runtimeClass).Build()
	reconciler := &controllers.ClusterHostReconciler{Client: c, Scheme: scheme}
	if _, err := reconciler.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(host)}); err != nil {
		t.Fatal(err)
	}
	var got clusterv1alpha1.T4ClusterHost
	if err := c.Get(ctx, client.ObjectKeyFromObject(host), &got); err != nil {
		t.Fatal(err)
	}
	storageReady := findCondition(got.Status.Conditions, "StorageReady")
	if storageReady == nil || storageReady.Status != metav1.ConditionFalse || storageReady.Reason != "StorageConformanceRequired" {
		t.Fatalf("unproven runtime-state storage was not rejected: %#v", storageReady)
	}
}

func TestWorkspaceCreateAlreadyExistsRefetchesForeignPVC(t *testing.T) {
	ctx := context.Background()
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
	workspace.UID = "workspace-uid"
	base := fake.NewClientBuilder().WithScheme(scheme).
		WithIndex(&clusterv1alpha1.T4Session{}, testWorkspaceSessionRefIndexField, testIndexWorkspaceSessionByWorkspaceRef).
		WithStatusSubresource(&clusterv1alpha1.T4Workspace{}, &corev1.PersistentVolumeClaim{}).
		WithObjects(testHost(), rwxStorageClass(), workspace).Build()
	c := &createAlreadyExistsClient{Client: base, raceKind: "PVC", hideWinnerFromCache: true}
	r := &controllers.WorkspaceReconciler{Client: c, APIReader: base, Scheme: scheme}
	if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(workspace)}); err != nil {
		t.Fatal(err)
	}
	if c.winner == nil {
		t.Fatal("PVC create race was not exercised")
	}
	var pvc corev1.PersistentVolumeClaim
	if err := base.Get(ctx, client.ObjectKeyFromObject(c.winner), &pvc); err != nil {
		t.Fatalf("foreign PVC winner was deleted: %v", err)
	}
	want := c.winner.(*corev1.PersistentVolumeClaim)
	if !reflect.DeepEqual(pvc.ObjectMeta, want.ObjectMeta) || !reflect.DeepEqual(pvc.Spec, want.Spec) {
		t.Fatalf("foreign PVC winner was mutated: %#v", pvc)
	}
	var failed clusterv1alpha1.T4Workspace
	if err := base.Get(ctx, client.ObjectKeyFromObject(workspace), &failed); err != nil {
		t.Fatal(err)
	}
	storageReady := findCondition(failed.Status.Conditions, "StorageReady")
	if failed.Status.PVCName != "" || storageReady == nil || storageReady.Status != metav1.ConditionFalse || storageReady.Reason != "PVCOwnershipConflict" || storageReady.ObservedGeneration != failed.Generation {
		t.Fatalf("foreign PVC winner was published as authoritative: status=%#v StorageReady=%#v", failed.Status, storageReady)
	}
}

func TestWorkspaceReadinessRejectsAuthoritativeForeignPVCReplacement(t *testing.T) {
	ctx := context.Background()
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
	workspace.UID = "workspace-uid"
	cachedPVC := ownedWorkspacePVC(workspace)
	cachedPVC.UID = "cached-pvc-uid"
	authoritativePVC := cachedPVC.DeepCopy()
	authoritativePVC.UID = "replacement-pvc-uid"
	authoritativePVC.Annotations = nil
	authoritativePVC.OwnerReferences = nil
	cacheClient := fake.NewClientBuilder().WithScheme(scheme).
		WithIndex(&clusterv1alpha1.T4Session{}, testWorkspaceSessionRefIndexField, testIndexWorkspaceSessionByWorkspaceRef).
		WithStatusSubresource(&clusterv1alpha1.T4Workspace{}, &corev1.PersistentVolumeClaim{}).
		WithObjects(testHost(), rwxStorageClass(), workspace, cachedPVC).Build()
	r := &controllers.WorkspaceReconciler{
		Client:    cacheClient,
		APIReader: &pvcOverrideReader{Reader: cacheClient, pvc: authoritativePVC},
		Scheme:    scheme,
	}
	if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(workspace)}); err != nil {
		t.Fatal(err)
	}
	var got clusterv1alpha1.T4Workspace
	if err := cacheClient.Get(ctx, client.ObjectKeyFromObject(workspace), &got); err != nil {
		t.Fatal(err)
	}
	storageReady := findCondition(got.Status.Conditions, "StorageReady")
	ready := findCondition(got.Status.Conditions, "Ready")
	if got.Status.PVCName != "" || got.Status.PVCPhase != "" || !got.Status.Capacity.IsZero() ||
		storageReady == nil || storageReady.Status != metav1.ConditionFalse || storageReady.Reason != "PVCOwnershipConflict" || storageReady.ObservedGeneration != got.Generation ||
		ready == nil || ready.Status != metav1.ConditionFalse || ready.ObservedGeneration != got.Generation {
		t.Fatalf("stale cached PVC published workspace authority: status=%#v StorageReady=%#v Ready=%#v", got.Status, storageReady, ready)
	}
}

func TestWorkspacePendingPVCPolicyFailsBeforeAuthority(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*corev1.PersistentVolumeClaim)
		reason string
	}{
		{name: "wrong class", reason: controllers.ReasonStorageClassMismatch, mutate: func(pvc *corev1.PersistentVolumeClaim) { pvc.Spec.StorageClassName = ptr("other-rwx") }},
		{name: "wrong access", reason: "PVCNotRWX", mutate: func(pvc *corev1.PersistentVolumeClaim) {
			pvc.Spec.AccessModes = []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce}
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			scheme := testScheme(t)
			workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
			workspace.UID = "workspace-uid"
			pvc := ownedWorkspacePVC(workspace)
			pvc.Status.Phase = corev1.ClaimPending
			test.mutate(pvc)
			c := fake.NewClientBuilder().WithScheme(scheme).
				WithIndex(&clusterv1alpha1.T4Session{}, testWorkspaceSessionRefIndexField, testIndexWorkspaceSessionByWorkspaceRef).
				WithStatusSubresource(&clusterv1alpha1.T4Workspace{}, &corev1.PersistentVolumeClaim{}).
				WithObjects(testHost(), rwxStorageClass(), workspace, pvc).Build()
			r := &controllers.WorkspaceReconciler{Client: c, APIReader: c, Scheme: scheme}
			if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(workspace)}); err != nil {
				t.Fatal(err)
			}
			var failed clusterv1alpha1.T4Workspace
			if err := c.Get(ctx, client.ObjectKeyFromObject(workspace), &failed); err != nil {
				t.Fatal(err)
			}
			condition := findCondition(failed.Status.Conditions, "StorageReady")
			if failed.Status.PVCName != "" || condition == nil || condition.Status != metav1.ConditionFalse || condition.Reason != test.reason {
				t.Fatalf("incompatible Pending PVC published authority: status=%#v condition=%#v", failed.Status, condition)
			}
		})
	}
}

func TestWorkspaceDeletionUsesAuthoritativePVCReader(t *testing.T) {
	ctx := context.Background()
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
	workspace.UID = "workspace-uid"
	workspace.Finalizers = []string{clusterv1alpha1.WorkspaceFinalizer}
	pvc := ownedWorkspacePVC(workspace)
	pvc.OwnerReferences = nil
	base := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Workspace{}).WithObjects(workspace, pvc).Build()
	if err := base.Delete(ctx, workspace); err != nil {
		t.Fatal(err)
	}
	c := &createAlreadyExistsClient{Client: base, raceKind: "PVC", winner: pvc, hideWinnerFromCache: true}
	r := &controllers.WorkspaceReconciler{Client: c, APIReader: base, Scheme: scheme}
	if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(workspace)}); err != nil {
		t.Fatal(err)
	}
	var waiting clusterv1alpha1.T4Workspace
	if err := base.Get(ctx, client.ObjectKeyFromObject(workspace), &waiting); err != nil {
		t.Fatalf("workspace finalizer ignored authoritative PVC conflict: %v", err)
	}
	condition := findCondition(waiting.Status.Conditions, "Ready")
	if condition == nil || condition.Reason != "CleanupOwnershipConflict" || !contains(waiting.Finalizers, clusterv1alpha1.WorkspaceFinalizer) {
		t.Fatalf("authoritative PVC conflict not retained: %#v", waiting)
	}
}

func TestWorkspaceDeletionUsesAuthoritativeSessionReader(t *testing.T) {
	ctx := context.Background()
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
	workspace.UID = "workspace-uid"
	workspace.Finalizers = []string{clusterv1alpha1.WorkspaceFinalizer}
	pvc := ownedWorkspacePVC(workspace)
	session := testSession()
	session.Spec.WorkspaceRef = workspace.Name
	cacheClient := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Workspace{}).WithObjects(workspace, pvc).Build()
	apiReader := fake.NewClientBuilder().WithScheme(scheme).WithObjects(pvc, session).Build()
	if err := cacheClient.Delete(ctx, workspace); err != nil {
		t.Fatal(err)
	}
	r := &controllers.WorkspaceReconciler{Client: cacheClient, APIReader: apiReader, Scheme: scheme}
	if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(workspace)}); err != nil {
		t.Fatal(err)
	}
	var waiting clusterv1alpha1.T4Workspace
	if err := cacheClient.Get(ctx, client.ObjectKeyFromObject(workspace), &waiting); err != nil {
		t.Fatalf("workspace finalizer ignored authoritative session: %v", err)
	}
	ready := findCondition(waiting.Status.Conditions, "Ready")
	if ready == nil || ready.Status != metav1.ConditionFalse || ready.Reason != "SessionsRemain" || ready.ObservedGeneration != waiting.Generation {
		t.Fatalf("Ready = %#v, want current-generation False/SessionsRemain", ready)
	}
	if !contains(waiting.Finalizers, clusterv1alpha1.WorkspaceFinalizer) {
		t.Fatal("workspace finalizer was removed while authoritative session remains")
	}
	var remainingPVC corev1.PersistentVolumeClaim
	if err := cacheClient.Get(ctx, client.ObjectKeyFromObject(pvc), &remainingPVC); err != nil {
		t.Fatalf("workspace PVC was deleted while authoritative session remains: %v", err)
	}
}

func TestRetainWorkspaceCreatesPVCWithoutGarbageCollectableOwner(t *testing.T) {
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyRetain)
	workspace.UID = "workspace-uid"
	c := fake.NewClientBuilder().WithScheme(scheme).
		WithIndex(&clusterv1alpha1.T4Session{}, testWorkspaceSessionRefIndexField, testIndexWorkspaceSessionByWorkspaceRef).
		WithStatusSubresource(&clusterv1alpha1.T4Workspace{}, &corev1.PersistentVolumeClaim{}).
		WithObjects(testHost(), rwxStorageClass(), workspace).Build()
	r := &controllers.WorkspaceReconciler{Client: c, Scheme: scheme}
	reconcileMany(t, 2, func() error {
		_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(workspace)})
		return err
	})
	var pvc corev1.PersistentVolumeClaim
	if err := c.Get(context.Background(), types.NamespacedName{Namespace: workspace.Namespace, Name: controllers.WorkspacePVCName(workspace)}, &pvc); err != nil {
		t.Fatal(err)
	}
	if len(pvc.OwnerReferences) != 0 || pvc.Annotations[clusterv1alpha1.WorkspaceUIDAnnotation] != string(workspace.UID) {
		t.Fatalf("retained PVC is exposed to owner garbage collection: %#v", pvc.ObjectMeta)
	}
}

func TestWorkspaceStorageFailsClosedWhenClassMissingOrNotRWX(t *testing.T) {
	for _, test := range []struct {
		name   string
		class  *storagev1.StorageClass
		reason string
	}{
		{name: "missing", reason: controllers.ReasonStorageClassNotFound},
		{name: "not-rwx", class: &storagev1.StorageClass{ObjectMeta: metav1.ObjectMeta{Name: "portable-rwx"}, Provisioner: "example.invalid/csi"}, reason: controllers.ReasonStorageClassNotRWX},
	} {
		t.Run(test.name, func(t *testing.T) {
			scheme := testScheme(t)
			workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
			workspace.Status.Phase = clusterv1alpha1.InfrastructureReady
			workspace.Status.Conditions = []metav1.Condition{{Type: "Ready", Status: metav1.ConditionTrue, Reason: "PVCBound", ObservedGeneration: workspace.Generation}}
			objects := []client.Object{testHost(), workspace}
			if test.class != nil {
				objects = append(objects, test.class)
			}
			c := fake.NewClientBuilder().WithScheme(scheme).
				WithIndex(&clusterv1alpha1.T4Session{}, testWorkspaceSessionRefIndexField, testIndexWorkspaceSessionByWorkspaceRef).
				WithStatusSubresource(&clusterv1alpha1.T4Workspace{}).
				WithObjects(objects...).Build()
			r := &controllers.WorkspaceReconciler{Client: c, Scheme: scheme}
			reconcileMany(t, 2, func() error {
				_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: types.NamespacedName{Namespace: "team", Name: "workspace-a"}})
				return err
			})
			var pvcs corev1.PersistentVolumeClaimList
			if err := c.List(context.Background(), &pvcs, client.InNamespace("team")); err != nil {
				t.Fatal(err)
			}
			if len(pvcs.Items) != 0 {
				t.Fatalf("fail-closed path created %d PVCs", len(pvcs.Items))
			}
			var got clusterv1alpha1.T4Workspace
			if err := c.Get(context.Background(), types.NamespacedName{Namespace: "team", Name: "workspace-a"}, &got); err != nil {
				t.Fatal(err)
			}
			condition := findCondition(got.Status.Conditions, "StorageReady")
			if condition == nil || condition.Status != metav1.ConditionFalse || condition.Reason != test.reason {
				t.Fatalf("StorageReady = %#v, want False/%s", condition, test.reason)
			}
			ready := findCondition(got.Status.Conditions, "Ready")
			if got.Status.Phase != clusterv1alpha1.InfrastructureFailed || ready == nil || ready.Status != metav1.ConditionFalse || ready.Reason != test.reason {
				t.Fatalf("revoked workspace status = %#v, Ready = %#v, want Failed and False/%s", got.Status, ready, test.reason)
			}
		})
	}
}

func TestRetainDeletionOrphansPVCBeforeRemovingFinalizer(t *testing.T) {
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyRetain)
	workspace.UID = "workspace-uid"
	workspace.Finalizers = []string{clusterv1alpha1.WorkspaceFinalizer}
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:        controllers.WorkspacePVCName(workspace),
			Namespace:   workspace.Namespace,
			Annotations: map[string]string{clusterv1alpha1.WorkspaceUIDAnnotation: string(workspace.UID)},
			OwnerReferences: []metav1.OwnerReference{{
				APIVersion: clusterv1alpha1.GroupVersion.String(), Kind: "T4Workspace", Name: workspace.Name, UID: workspace.UID, Controller: ptr(true),
			}},
		},
		Spec: corev1.PersistentVolumeClaimSpec{StorageClassName: ptr("portable-rwx"), AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Workspace{}).WithObjects(testHost(), rwxStorageClass(), workspace, pvc).Build()
	if err := c.Delete(context.Background(), workspace); err != nil {
		t.Fatal(err)
	}
	r := &controllers.WorkspaceReconciler{Client: c, Scheme: scheme}
	reconcileMany(t, 2, func() error {
		_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(workspace)})
		return err
	})
	var retained corev1.PersistentVolumeClaim
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(pvc), &retained); err != nil {
		t.Fatalf("retained PVC was deleted: %v", err)
	}
	if len(retained.OwnerReferences) != 0 || retained.Annotations[clusterv1alpha1.RetainedPVCAnnotation] != "true" {
		t.Fatalf("retained PVC was not orphaned safely: %#v", retained.ObjectMeta)
	}
	var gone clusterv1alpha1.T4Workspace
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(workspace), &gone); !apierrors.IsNotFound(err) {
		t.Fatalf("workspace should be deleted after retention, got %v", err)
	}
}

func TestWorkspaceDeletionWaitsForSessionResources(t *testing.T) {
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyRetain)
	workspace.UID = "workspace-uid"
	workspace.Finalizers = []string{clusterv1alpha1.WorkspaceFinalizer}
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name: controllers.WorkspacePVCName(workspace), Namespace: workspace.Namespace,
			OwnerReferences: []metav1.OwnerReference{{APIVersion: clusterv1alpha1.GroupVersion.String(), Kind: "T4Workspace", Name: workspace.Name, UID: workspace.UID, Controller: ptr(true)}},
		},
		Spec: corev1.PersistentVolumeClaimSpec{StorageClassName: ptr("portable-rwx"), AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
	}
	session := testSession()
	session.Spec.WorkspaceRef = workspace.Name
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Workspace{}).WithObjects(workspace, pvc, session).Build()
	if err := c.Delete(context.Background(), workspace); err != nil {
		t.Fatal(err)
	}
	r := &controllers.WorkspaceReconciler{Client: c, Scheme: scheme}
	if _, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(workspace)}); err != nil {
		t.Fatal(err)
	}
	var waiting clusterv1alpha1.T4Workspace
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(workspace), &waiting); err != nil {
		t.Fatalf("workspace deletion did not wait: %v", err)
	}
	condition := findCondition(waiting.Status.Conditions, "Ready")
	if condition == nil || condition.Reason != "SessionsRemain" {
		t.Fatalf("Ready = %#v, want SessionsRemain", condition)
	}
	var retained corev1.PersistentVolumeClaim
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(pvc), &retained); err != nil {
		t.Fatalf("workspace PVC changed during wait: %v", err)
	}
	if len(retained.OwnerReferences) != 1 {
		t.Fatalf("workspace PVC was orphaned before sessions exited: %#v", retained.OwnerReferences)
	}
}

func TestSessionPodCreateRevalidatesAuthoritativePVC(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*corev1.PersistentVolumeClaim)
	}{
		{name: "replacement UID", mutate: func(pvc *corev1.PersistentVolumeClaim) { pvc.UID = "replacement-pvc-uid" }},
		{name: "foreign owner", mutate: func(pvc *corev1.PersistentVolumeClaim) {
			pvc.OwnerReferences = []metav1.OwnerReference{{APIVersion: "v1", Kind: "Secret", Name: "foreign", UID: "foreign-uid", Controller: ptr(true)}}
		}},
		{name: "storage class drift", mutate: func(pvc *corev1.PersistentVolumeClaim) { pvc.Spec.StorageClassName = ptr("other-rwx") }},
		{name: "access mode drift", mutate: func(pvc *corev1.PersistentVolumeClaim) {
			pvc.Spec.AccessModes = []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce}
		}},
		{name: "unbound replacement", mutate: func(pvc *corev1.PersistentVolumeClaim) { pvc.Status.Phase = corev1.ClaimPending }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			scheme := testScheme(t)
			workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
			workspace.UID = "workspace-uid"
			workspace.Status.PVCName = controllers.WorkspacePVCName(workspace)
			cachedPVC := ownedWorkspacePVC(workspace)
			cachedPVC.UID = "cached-pvc-uid"
			authoritativePVC := cachedPVC.DeepCopy()
			test.mutate(authoritativePVC)
			session := testSession()
			session.UID = "session-uid"
			cacheClient := fake.NewClientBuilder().WithScheme(scheme).
				WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
				WithObjects(testHost(), workspace, cachedPVC, session).Build()
			r := configuredSessionReconciler(cacheClient, scheme)
			r.APIReader = &pvcOverrideReader{Reader: cacheClient, pvc: authoritativePVC}
			if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
				t.Fatal(err)
			}
			var pods corev1.PodList
			if err := cacheClient.List(ctx, &pods, client.InNamespace(session.Namespace)); err != nil {
				t.Fatal(err)
			}
			if len(pods.Items) != 0 {
				t.Fatalf("created %d Pods after authoritative PVC %s", len(pods.Items), test.name)
			}
			var got clusterv1alpha1.T4Session
			if err := cacheClient.Get(ctx, client.ObjectKeyFromObject(session), &got); err != nil {
				t.Fatal(err)
			}
			workspaceReady := findCondition(got.Status.Conditions, "WorkspaceReady")
			if got.Status.PodName != "" || workspaceReady == nil || workspaceReady.Status != metav1.ConditionFalse || workspaceReady.Reason != "PVCAuthorityChanged" || workspaceReady.ObservedGeneration != got.Generation {
				t.Fatalf("authoritative PVC %s published session authority: status=%#v WorkspaceReady=%#v", test.name, got.Status, workspaceReady)
			}
		})
	}
}

func TestSessionExistingPodRepairRejectsAuthoritativeForeignPVCReplacement(t *testing.T) {
	ctx := context.Background()
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
	workspace.UID = "workspace-uid"
	workspace.Status.PVCName = controllers.WorkspacePVCName(workspace)
	cachedPVC := ownedWorkspacePVC(workspace)
	cachedPVC.UID = "cached-pvc-uid"
	session := testSession()
	session.UID = "session-uid"
	cacheClient := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
		WithObjects(testHost(), workspace, cachedPVC, session).Build()
	r := configuredSessionReconciler(cacheClient, scheme)
	reconcileMany(t, 2, func() error {
		_, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
		return err
	})
	var pod corev1.Pod
	if err := cacheClient.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: controllers.SessionPodName(session)}, &pod); err != nil {
		t.Fatal(err)
	}
	pod.Labels = nil
	if err := cacheClient.Update(ctx, &pod); err != nil {
		t.Fatal(err)
	}
	authoritativePVC := cachedPVC.DeepCopy()
	authoritativePVC.UID = "replacement-pvc-uid"
	authoritativePVC.Annotations = nil
	authoritativePVC.OwnerReferences = nil
	r.APIReader = &pvcOverrideReader{Reader: cacheClient, pvc: authoritativePVC}
	if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
		t.Fatal(err)
	}
	if err := cacheClient.Get(ctx, client.ObjectKeyFromObject(&pod), &pod); !apierrors.IsNotFound(err) {
		t.Fatalf("existing Pod survived authoritative PVC replacement: %v", err)
	}
	var got clusterv1alpha1.T4Session
	if err := cacheClient.Get(ctx, client.ObjectKeyFromObject(session), &got); err != nil {
		t.Fatal(err)
	}
	workspaceReady := findCondition(got.Status.Conditions, "WorkspaceReady")
	if got.Status.PodName != "" || workspaceReady == nil || workspaceReady.Status != metav1.ConditionFalse || workspaceReady.Reason != "PVCAuthorityChanged" || workspaceReady.ObservedGeneration != got.Generation {
		t.Fatalf("existing Pod repair retained stale PVC authority: status=%#v WorkspaceReady=%#v", got.Status, workspaceReady)
	}
}

func TestSessionFailsClosedWhenAnyOMPReferenceIsMissing(t *testing.T) {
	for _, test := range []struct {
		name   string
		remove func(*controllers.SessionOMPConfig)
		reason string
	}{
		{name: "ConfigMap", remove: func(config *controllers.SessionOMPConfig) { config.ConfigMapName = "" }, reason: "OMPReferencesMissing"},
		{name: "models key", remove: func(config *controllers.SessionOMPConfig) { config.ModelsKey = "" }, reason: "OMPReferencesMissing"},
		{name: "settings key", remove: func(config *controllers.SessionOMPConfig) { config.SettingsKey = "" }, reason: "OMPReferencesMissing"},
	} {
		t.Run(test.name, func(t *testing.T) {
			scheme := testScheme(t)
			workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
			workspace.Status.PVCName = "workspace-a-data"
			pvc := &corev1.PersistentVolumeClaim{
				ObjectMeta: metav1.ObjectMeta{Name: workspace.Status.PVCName, Namespace: "team"},
				Spec:       corev1.PersistentVolumeClaimSpec{StorageClassName: ptr("portable-rwx"), AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
				Status:     corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound},
			}
			session := testSession()
			c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}).WithObjects(testHost(), workspace, pvc, session).Build()
			r := configuredSessionReconciler(c, scheme)
			test.remove(&r.OMPConfig)
			if _, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
				t.Fatal(err)
			}
			assertObjectCounts(t, c, 0, 0)
			var got clusterv1alpha1.T4Session
			if err := c.Get(context.Background(), client.ObjectKeyFromObject(session), &got); err != nil {
				t.Fatal(err)
			}
			condition := findCondition(got.Status.Conditions, "RuntimeConfigured")
			if condition == nil || condition.Status != metav1.ConditionFalse || condition.Reason != test.reason {
				t.Fatalf("RuntimeConfigured = %#v, want False/%s", condition, test.reason)
			}
		})
	}
}

func TestSessionRejectsInvalidOMPProjectionReferences(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*controllers.SessionOMPConfig)
		reason string
	}{
		{name: "identical projected keys", mutate: func(config *controllers.SessionOMPConfig) { config.SettingsKey = config.ModelsKey }, reason: "OMPReferencesInvalid"},
	} {
		t.Run(test.name, func(t *testing.T) {
			scheme := testScheme(t)
			session := testSession()
			c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Session{}).WithObjects(session).Build()
			r := configuredSessionReconciler(c, scheme)
			test.mutate(&r.OMPConfig)
			if _, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
				t.Fatal(err)
			}
			assertObjectCounts(t, c, 0, 0)
			var got clusterv1alpha1.T4Session
			if err := c.Get(context.Background(), client.ObjectKeyFromObject(session), &got); err != nil {
				t.Fatal(err)
			}
			condition := findCondition(got.Status.Conditions, "RuntimeConfigured")
			if condition == nil || condition.Status != metav1.ConditionFalse || condition.Reason != test.reason {
				t.Fatalf("RuntimeConfigured = %#v, want False/%s", condition, test.reason)
			}
		})
	}
}

func TestSessionRejectsCredentialBearingModelsConfiguration(t *testing.T) {
	for _, test := range []struct {
		name   string
		models string
	}{
		{name: "malformed YAML", models: "providers: ["},
		{name: "missing providers", models: "models: []\n"},
		{name: "missing auth", models: "providers:\n  public:\n    baseUrl: https://model.example/v1\n"},
		{name: "authenticated provider", models: "providers:\n  public:\n    baseUrl: https://model.example/v1\n    auth: api-key\n"},
		{name: "API key", models: "providers:\n  public:\n    baseUrl: https://model.example/v1\n    auth: none\n    apiKey: reusable\n"},
		{name: "authorization header", models: "providers:\n  public:\n    baseUrl: https://model.example/v1\n    auth: none\n    headers:\n      Authorization: Bearer reusable\n"},
		{name: "x-api-key header", models: "providers:\n  public:\n    baseUrl: https://model.example/v1\n    auth: none\n    headers:\n      X-API-Key: reusable\n"},
		{name: "custom header", models: "providers:\n  public:\n    baseUrl: https://model.example/v1\n    auth: none\n    headers:\n      X-Custom-Auth: reusable\n"},
		{name: "URL userinfo", models: "providers:\n  public:\n    baseUrl: https://user:reusable@model.example/v1\n    auth: none\n"},
		{name: "URL query credential", models: "providers:\n  public:\n    baseUrl: https://model.example/v1?access=reusable\n    auth: none\n"},
		{name: "duplicate auth key", models: "providers:\n  public:\n    baseUrl: https://model.example/v1\n    auth: none\n    auth: api-key\n"},
		{name: "YAML merge alias", models: "shared: &shared\n  auth: api-key\nproviders:\n  public:\n    <<: *shared\n    baseUrl: https://model.example/v1\n    auth: none\n"},
	} {
		t.Run(test.name, func(t *testing.T) {
			scheme := testScheme(t)
			workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
			workspace.Status.PVCName = "workspace-a-data"
			pvc := &corev1.PersistentVolumeClaim{
				ObjectMeta: metav1.ObjectMeta{Name: workspace.Status.PVCName, Namespace: "team"},
				Spec:       corev1.PersistentVolumeClaimSpec{StorageClassName: ptr("portable-rwx"), AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
				Status:     corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound},
			}
			session := testSession()
			c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}).WithObjects(testHost(), workspace, pvc, session).Build()
			r := configuredSessionReconciler(c, scheme)
			var configMap corev1.ConfigMap
			key := types.NamespacedName{Namespace: "team", Name: r.OMPConfig.ConfigMapName}
			if err := c.Get(context.Background(), key, &configMap); err != nil {
				t.Fatal(err)
			}
			configMap.Data[r.OMPConfig.ModelsKey] = test.models
			if err := c.Update(context.Background(), &configMap); err != nil {
				t.Fatal(err)
			}
			reconcileMany(t, 2, func() error {
				_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
				return err
			})
			var got clusterv1alpha1.T4Session
			if err := c.Get(context.Background(), client.ObjectKeyFromObject(session), &got); err != nil {
				t.Fatal(err)
			}
			condition := findCondition(got.Status.Conditions, "RuntimeConfigured")
			if condition == nil || condition.Status != metav1.ConditionFalse || condition.Reason != "OMPModelsAuthenticationUnsafe" {
				t.Fatalf("RuntimeConfigured = %#v, want False/OMPModelsAuthenticationUnsafe", condition)
			}
		})
	}
}

func TestSessionRejectsCredentialBearingSettingsConfiguration(t *testing.T) {
	for _, test := range []struct {
		name     string
		settings string
	}{
		{name: "broker token", settings: "auth.broker.token: reusable\n"},
		{name: "nested broker token", settings: "auth:\n  broker:\n    token: reusable\n"},
		{name: "hindsight token", settings: "hindsight.apiToken: reusable\n"},
		{name: "searxng token", settings: "searxng.token: reusable\n"},
		{name: "auto QA token", settings: "dev.autoqaPush.token: reusable\n"},
		{name: "custom headers", settings: "provider:\n  headers:\n    X-Custom-Auth: reusable\n"},
		{name: "duplicate key", settings: "theme: dark\ntheme: light\n"},
		{name: "YAML alias", settings: "theme: &theme dark\ncopy: *theme\n"},
	} {
		t.Run(test.name, func(t *testing.T) {
			scheme := testScheme(t)
			workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
			workspace.Status.PVCName = "workspace-a-data"
			pvc := &corev1.PersistentVolumeClaim{
				ObjectMeta: metav1.ObjectMeta{Name: workspace.Status.PVCName, Namespace: "team"},
				Spec:       corev1.PersistentVolumeClaimSpec{StorageClassName: ptr("portable-rwx"), AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
				Status:     corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound},
			}
			session := testSession()
			c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}).WithObjects(testHost(), workspace, pvc, session).Build()
			r := configuredSessionReconciler(c, scheme)
			var configMap corev1.ConfigMap
			key := types.NamespacedName{Namespace: "team", Name: r.OMPConfig.ConfigMapName}
			if err := c.Get(context.Background(), key, &configMap); err != nil {
				t.Fatal(err)
			}
			configMap.Data[r.OMPConfig.SettingsKey] = test.settings
			if err := c.Update(context.Background(), &configMap); err != nil {
				t.Fatal(err)
			}
			reconcileMany(t, 2, func() error {
				_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
				return err
			})
			var got clusterv1alpha1.T4Session
			if err := c.Get(context.Background(), client.ObjectKeyFromObject(session), &got); err != nil {
				t.Fatal(err)
			}
			condition := findCondition(got.Status.Conditions, "RuntimeConfigured")
			if condition == nil || condition.Status != metav1.ConditionFalse || condition.Reason != "OMPSettingsAuthenticationUnsafe" {
				t.Fatalf("RuntimeConfigured = %#v, want False/OMPSettingsAuthenticationUnsafe", condition)
			}
		})
	}
}

func TestSessionRuntimeImageMustBeImmutableDigest(t *testing.T) {
	for _, test := range []struct {
		name       string
		image      string
		wantReason string
	}{
		{name: "tag only", image: "registry.example/session:latest", wantReason: "RuntimeImageInvalid"},
		{name: "malformed digest", image: "registry.example/session@sha256:deadbeef", wantReason: "RuntimeImageInvalid"},
		{name: "uppercase algorithm", image: "registry.example/session@SHA256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", wantReason: "RuntimeImageInvalid"},
		{name: "uppercase digest", image: "registry.example/session@sha256:ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789", wantReason: "RuntimeImageInvalid"},
		{name: "registry port and path", image: "registry.example:5443/team/session-runtime@sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"},
	} {
		t.Run(test.name, func(t *testing.T) {
			scheme := testScheme(t)
			workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
			workspace.Status.PVCName = "workspace-a-data"
			pvc := &corev1.PersistentVolumeClaim{
				ObjectMeta: metav1.ObjectMeta{Name: workspace.Status.PVCName, Namespace: "team"},
				Spec:       corev1.PersistentVolumeClaimSpec{StorageClassName: ptr("portable-rwx"), AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
				Status:     corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound},
			}
			session := testSession()
			c := fake.NewClientBuilder().WithScheme(scheme).
				WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
				WithObjects(testHost(), workspace, pvc, session).Build()
			r := configuredSessionReconciler(c, scheme)
			r.RuntimeImage = test.image
			if _, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
				t.Fatal(err)
			}
			if test.wantReason == "" {
				assertObjectCounts(t, c, 1, 1)
				var pod corev1.Pod
				if err := c.Get(context.Background(), types.NamespacedName{Namespace: session.Namespace, Name: controllers.SessionPodName(session)}, &pod); err != nil {
					t.Fatal(err)
				}
				if pod.Spec.Containers[0].Image != test.image {
					t.Fatalf("runtime image = %q, want %q", pod.Spec.Containers[0].Image, test.image)
				}
				return
			}
			assertObjectCounts(t, c, 0, 0)
			var got clusterv1alpha1.T4Session
			if err := c.Get(context.Background(), client.ObjectKeyFromObject(session), &got); err != nil {
				t.Fatal(err)
			}
			condition := findCondition(got.Status.Conditions, "RuntimeConfigured")
			if condition == nil || condition.Status != metav1.ConditionFalse || condition.Reason != test.wantReason {
				t.Fatalf("RuntimeConfigured = %#v, want False/%s", condition, test.wantReason)
			}
		})
	}
}

func TestSessionAuthorityRevocationDeletesOwnedPodAndService(t *testing.T) {
	for _, test := range []struct {
		name          string
		conditionType string
		wantReason    string
		revoke        func(context.Context, client.Client, *controllers.SessionReconciler) error
	}{
		{name: "runtime image", conditionType: "RuntimeConfigured", wantReason: "RuntimeImageInvalid", revoke: func(_ context.Context, _ client.Client, r *controllers.SessionReconciler) error {
			r.RuntimeImage = "registry.example/session:latest"
			return nil
		}},
		{name: "runtime profile", conditionType: "RuntimeConfigured", wantReason: "RuntimeProfileNotAllowed", revoke: func(ctx context.Context, c client.Client, _ *controllers.SessionReconciler) error {
			var host clusterv1alpha1.T4ClusterHost
			if err := c.Get(ctx, types.NamespacedName{Namespace: "team", Name: "host-a"}, &host); err != nil {
				return err
			}
			host.Spec.RuntimeProfiles = nil
			return c.Update(ctx, &host)
		}},
		{name: "storage declaration", conditionType: "WorkspaceReady", wantReason: controllers.ReasonStorageClassNotRWX, revoke: func(ctx context.Context, c client.Client, _ *controllers.SessionReconciler) error {
			var storageClass storagev1.StorageClass
			if err := c.Get(ctx, types.NamespacedName{Name: "portable-rwx"}, &storageClass); err != nil {
				return err
			}
			storageClass.Annotations = nil
			return c.Update(ctx, &storageClass)
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			scheme := testScheme(t)
			workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
			workspace.Status.PVCName = "workspace-a-data"
			pvc := &corev1.PersistentVolumeClaim{
				ObjectMeta: metav1.ObjectMeta{Name: workspace.Status.PVCName, Namespace: "team"},
				Spec:       corev1.PersistentVolumeClaimSpec{StorageClassName: ptr("portable-rwx"), AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
				Status:     corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound},
			}
			session := testSession()
			session.UID = "session-uid"
			c := fake.NewClientBuilder().WithScheme(scheme).
				WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
				WithObjects(testHost(), workspace, pvc, session).Build()
			r := configuredSessionReconciler(c, scheme)
			reconcileMany(t, 2, func() error {
				_, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
				return err
			})
			assertObjectCounts(t, c, 1, 1)
			if err := test.revoke(ctx, c, r); err != nil {
				t.Fatal(err)
			}
			if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
				t.Fatal(err)
			}
			assertObjectCounts(t, c, 0, 0)
			var got clusterv1alpha1.T4Session
			if err := c.Get(ctx, client.ObjectKeyFromObject(session), &got); err != nil {
				t.Fatal(err)
			}
			condition := findCondition(got.Status.Conditions, test.conditionType)
			available := findCondition(got.Status.Conditions, "Available")
			if condition == nil || condition.Status != metav1.ConditionFalse || condition.Reason != test.wantReason ||
				available == nil || available.Status != metav1.ConditionFalse || available.Reason != test.wantReason ||
				got.Status.PodName != "" || got.Status.ServiceName != "" {
				t.Fatalf("revoked session status = %#v, condition = %#v, available = %#v", got.Status, condition, available)
			}
		})
	}
}

func TestSessionNamesProduceSafeRuntimeIdentities(t *testing.T) {
	for _, sessionName := range []string{
		"release.2026.07.21",
		"session-with-a-very-long-name-that-exceeds-sixty-three-characters-and-remains-valid",
	} {
		t.Run(sessionName, func(t *testing.T) {
			scheme := testScheme(t)
			workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
			workspace.Status.PVCName = "workspace-a-data"
			pvc := &corev1.PersistentVolumeClaim{
				ObjectMeta: metav1.ObjectMeta{Name: workspace.Status.PVCName, Namespace: "team"},
				Spec:       corev1.PersistentVolumeClaimSpec{StorageClassName: ptr("portable-rwx"), AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
				Status:     corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound},
			}
			session := testSession()
			session.Name = sessionName
			session.UID = types.UID("uid-" + sessionName)
			c := fake.NewClientBuilder().WithScheme(scheme).
				WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
				WithObjects(testHost(), workspace, pvc, session).Build()
			r := configuredSessionReconciler(c, scheme)
			if _, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
				t.Fatal(err)
			}
			var pod corev1.Pod
			if err := c.Get(context.Background(), types.NamespacedName{Namespace: session.Namespace, Name: controllers.SessionPodName(session)}, &pod); err != nil {
				t.Fatal(err)
			}
			var service corev1.Service
			if err := c.Get(context.Background(), types.NamespacedName{Namespace: session.Namespace, Name: controllers.SessionServiceName(session)}, &service); err != nil {
				t.Fatal(err)
			}
			for kind, name := range map[string]string{"Pod": pod.Name, "Service": service.Name} {
				if len(name) > 63 || len(utilvalidation.IsDNS1123Label(name)) != 0 {
					t.Fatalf("%s name %q is not a DNS label", kind, name)
				}
			}
			values := map[string]string{}
			for _, env := range pod.Spec.Containers[0].Env {
				values[env.Name] = env.Value
			}
			cmuxID := strings.TrimPrefix(pod.Name, "t4-session-")
			runtimeID := controllers.RuntimeStateFilesystemRoot(session)
			if len(cmuxID) > 63 || len(utilvalidation.IsDNS1123Label(cmuxID)) != 0 ||
				len(runtimeID) > 63 || len(utilvalidation.IsDNS1123Label(runtimeID)) != 0 || !strings.HasPrefix(runtimeID, "runtime-") ||
				values["T4_SESSION_NAME"] != cmuxID || values["T4_SESSION_STATE_ID"] != runtimeID || values["T4_RUNTIME_ID"] != runtimeID {
				t.Fatalf("runtime identity = name %q state %q runtime %q, want cmux %q and runtime state ID %q", values["T4_SESSION_NAME"], values["T4_SESSION_STATE_ID"], values["T4_RUNTIME_ID"], cmuxID, runtimeID)
			}
			if generation := values["T4_RUNTIME_GENERATION"]; len(generation) != 28 || !strings.HasPrefix(generation, "gen_") {
				t.Fatalf("runtime generation was not projected as a bounded controller-owned token: %q", generation)
			}
		})
	}
}

func TestSessionWaitsForBoundRWXThenCreatesExactlyOnePodAndService(t *testing.T) {
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
	workspace.Status.PVCName = "workspace-a-data"
	workspace.Status.Phase = clusterv1alpha1.InfrastructurePending
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: workspace.Status.PVCName, Namespace: "team"},
		Spec:       corev1.PersistentVolumeClaimSpec{StorageClassName: ptr("portable-rwx"), AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
		Status:     corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimPending},
	}
	session := testSession()
	c := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(&clusterv1alpha1.T4Workspace{}, &clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
		WithObjects(testHost(), workspace, pvc, session).Build()
	r := configuredSessionReconciler(c, scheme)
	r.RuntimeImage = testRuntimeImage
	r.KubernetesAPIAudience = "kubernetes.custom.example"
	reconcileMany(t, 2, func() error {
		_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
		return err
	})
	assertObjectCounts(t, c, 0, 0)

	if err := c.Get(context.Background(), client.ObjectKeyFromObject(pvc), pvc); err != nil {
		t.Fatal(err)
	}
	pvc.Status.Phase = corev1.ClaimBound
	pvc.Status.Capacity = corev1.ResourceList{corev1.ResourceStorage: apiresource.MustParse("10Gi")}
	if err := c.Status().Update(context.Background(), pvc); err != nil {
		t.Fatal(err)
	}
	reconcileMany(t, 4, func() error {
		_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
		return err
	})
	assertObjectCounts(t, c, 1, 1)

	var pods corev1.PodList
	if err := c.List(context.Background(), &pods, client.InNamespace("team")); err != nil {
		t.Fatal(err)
	}
	pod := pods.Items[0]
	if pod.Spec.AutomountServiceAccountToken == nil || *pod.Spec.AutomountServiceAccountToken {
		t.Fatal("session pod must disable automatic ServiceAccount token mounting")
	}
	if len(pod.Spec.Containers) != 3 || pod.Spec.Containers[0].Name != "session-authority" || pod.Spec.Containers[1].Name != "session-shell" || pod.Spec.Containers[2].Name != "session-credential" {
		t.Fatalf("session principal containers = %#v", pod.Spec.Containers)
	}
	if pod.Spec.Containers[0].Image != r.RuntimeImage {
		t.Fatalf("controller did not use administrator-owned runtime image: %q", pod.Spec.Containers[0].Image)
	}
	if pod.Spec.Containers[0].SecurityContext == nil || pod.Spec.Containers[0].SecurityContext.Privileged != nil && *pod.Spec.Containers[0].SecurityContext.Privileged {
		t.Fatal("session runtime is not restricted")
	}
	authorityMounts := pod.Spec.Containers[0].VolumeMounts
	shellMounts := pod.Spec.Containers[1].VolumeMounts
	credentialMounts := pod.Spec.Containers[2].VolumeMounts
	if len(authorityMounts) != 6 ||
		!hasMount(authorityMounts, "workspace", "/workspace") ||
		!hasMount(authorityMounts, "runtime-state", "/runtime-state") ||
		!hasMount(authorityMounts, "runtime", "/run") ||
		!hasMount(authorityMounts, "credential-broker", "/run/t4-credential") ||
		!hasMount(authorityMounts, "authority-temporary", "/tmp") ||
		!hasReadOnlyMount(authorityMounts, "omp-config-source", "/run/t4-omp-config-source") ||
		len(shellMounts) != 5 ||
		!hasMount(shellMounts, "workspace", "/workspace") ||
		!hasMount(shellMounts, "runtime-state", "/runtime-state") ||
		!hasMount(shellMounts, "runtime", "/run") ||
		!hasMount(shellMounts, "temporary", "/tmp") ||
		!hasMount(shellMounts, "shared-memory", "/dev/shm") ||
		!hasReadOnlyMount(credentialMounts, "kubernetes-api-access", "/var/run/secrets/kubernetes.io/serviceaccount") ||
		!hasReadOnlyMount(credentialMounts, "generation-auth", "/run/t4-generation-auth") {
		t.Fatalf("session principal mounts = authority:%#v shell:%#v credential:%#v", authorityMounts, shellMounts, credentialMounts)
	}
	if pod.Spec.ShareProcessNamespace == nil || !*pod.Spec.ShareProcessNamespace {
		t.Fatal("split runtime containers must share a process namespace for ordered shutdown")
	}
	for _, env := range pod.Spec.Containers[1].Env {
		if env.Name == "T4_GENERATION_AUTH_PATH" || env.Name == "T4_OMP_EXECUTABLE" || env.Name == "T4_OMP_CONFIG_SOURCE_DIR" {
			t.Fatalf("shell principal received authority environment: %#v", env)
		}
	}
	for _, container := range pod.Spec.Containers[:2] {
		for _, env := range container.Env {
			if strings.Contains(env.Name, "KUBERNETES") || env.Name == "T4_GENERATION_AUTH_PATH" || env.Name == "T4_WRITER_LEASE_NAME" || env.Name == "POD_UID" {
				t.Fatalf("%s received credential environment: %#v", container.Name, env)
			}
		}
	}
	if pod.Spec.ServiceAccountName != controllers.SessionServiceAccountName(session) {
		t.Fatalf("session ServiceAccount = %q, want isolated %q", pod.Spec.ServiceAccountName, controllers.SessionServiceAccountName(session))
	}
	var writerRole rbacv1.Role
	if err := c.Get(context.Background(), types.NamespacedName{Namespace: session.Namespace, Name: controllers.SessionWriterRoleName(session)}, &writerRole); err != nil {
		t.Fatal(err)
	}
	if len(writerRole.Rules) != 1 || !reflect.DeepEqual(writerRole.Rules[0].ResourceNames, []string{controllers.SessionWriterLeaseName(session)}) ||
		!reflect.DeepEqual(writerRole.Rules[0].Verbs, []string{"get", "update"}) {
		t.Fatalf("session writer Role can reach sibling leases: %#v", writerRole.Rules)
	}
	serverIdentity := ""
	configSource := ""
	for i := range pod.Spec.Containers[2].Env {
		env := &pod.Spec.Containers[2].Env[i]
		if env.Name == "T4_CLUSTER_SERVER_SERVICE_ACCOUNT" {
			serverIdentity = env.Value
		}
	}
	for i := range pod.Spec.Containers[0].Env {
		env := &pod.Spec.Containers[0].Env[i]
		if env.Name == "T4_OMP_CONFIG_SOURCE_DIR" {
			configSource = env.Value
		}
		if env.ValueFrom != nil && env.ValueFrom.SecretKeyRef != nil {
			t.Fatalf("session runtime retained a Secret environment reference: %#v", env)
		}
	}
	if serverIdentity != controllers.DefaultServerServiceAccount {
		t.Fatalf("expected server ServiceAccount = %q", serverIdentity)
	}
	if configSource != "/run/t4-omp-config-source" {
		t.Fatalf("OMP preflight source = %q", configSource)
	}
	if len(pod.Spec.Containers[0].Args) != 0 {
		t.Fatalf("session runtime received credential arguments: %#v", pod.Spec.Containers[0].Args)
	}
	if !hasMount(pod.Spec.Containers[2].VolumeMounts, "kubernetes-api-access", "/var/run/secrets/kubernetes.io/serviceaccount") {
		t.Fatal("explicit Kubernetes reviewer projection is not mounted only on credential broker")
	}
	var projection *corev1.ProjectedVolumeSource
	for _, volume := range pod.Spec.Volumes {
		if volume.Name == "kubernetes-api-access" {
			projection = volume.Projected
		}
	}
	if projection == nil || len(projection.Sources) != 3 {
		t.Fatalf("Kubernetes reviewer projection = %#v", projection)
	}
	serviceToken := projection.Sources[0].ServiceAccountToken
	if serviceToken == nil || serviceToken.Audience != r.KubernetesAPIAudience || serviceToken.ExpirationSeconds == nil || *serviceToken.ExpirationSeconds != controllers.SessionReviewerTokenExpirationSeconds || serviceToken.Path != "token" {
		t.Fatalf("reviewer token projection = %#v", serviceToken)
	}
	clusterCA := projection.Sources[1].ConfigMap
	if clusterCA == nil || clusterCA.Name != "kube-root-ca.crt" || len(clusterCA.Items) != 1 || clusterCA.Items[0].Key != "ca.crt" || clusterCA.Items[0].Path != "ca.crt" {
		t.Fatalf("cluster CA projection = %#v", clusterCA)
	}
	namespace := projection.Sources[2].DownwardAPI
	if namespace == nil || len(namespace.Items) != 1 || namespace.Items[0].Path != "namespace" || namespace.Items[0].FieldRef == nil || namespace.Items[0].FieldRef.FieldPath != "metadata.namespace" {
		t.Fatalf("namespace projection = %#v", namespace)
	}
	var ompConfig *corev1.ConfigMapVolumeSource
	for i := range pod.Spec.Volumes {
		if pod.Spec.Volumes[i].Name == "omp-config-source" {
			ompConfig = pod.Spec.Volumes[i].ConfigMap
		}
	}
	if ompConfig == nil || ompConfig.Name != r.OMPConfig.ConfigMapName || ompConfig.Optional == nil || *ompConfig.Optional || ompConfig.DefaultMode == nil || *ompConfig.DefaultMode != 0440 || len(ompConfig.Items) != 2 {
		t.Fatalf("OMP ConfigMap projection = %#v", ompConfig)
	}
	if got := ompConfig.Items[0]; got.Key != r.OMPConfig.ModelsKey || got.Path != "models.yml" || got.Mode == nil || *got.Mode != 0440 {
		t.Fatalf("OMP models projection = %#v", got)
	}
	if got := ompConfig.Items[1]; got.Key != r.OMPConfig.SettingsKey || got.Path != "config.yml" || got.Mode == nil || *got.Mode != 0440 {
		t.Fatalf("OMP settings projection = %#v", got)
	}
}

func TestSessionRuntimeStatePVCUsesIndependentProfileAndDurableMount(t *testing.T) {
	ctx := context.Background()
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
	workspace.UID = "workspace-uid"
	workspace.Status.PVCName = controllers.WorkspacePVCName(workspace)
	workspacePVC := ownedWorkspacePVC(workspace)
	session := testSession()
	session.UID = "session-uid"
	c := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
		WithObjects(testHost(), workspace, workspacePVC, session).Build()
	r := configuredSessionReconciler(c, scheme)

	reconcileMany(t, 5, func() error {
		_, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
		return err
	})
	assertObjectCounts(t, c, 1, 1)

	var runtimePVC corev1.PersistentVolumeClaim
	if err := c.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: controllers.RuntimeStatePVCName(session)}, &runtimePVC); err != nil {
		t.Fatal(err)
	}
	requested := runtimePVC.Spec.Resources.Requests[corev1.ResourceStorage]
	if pvcClass := runtimePVC.Spec.StorageClassName; pvcClass == nil || *pvcClass != "runtime-rwo" ||
		len(runtimePVC.Spec.AccessModes) != 1 || runtimePVC.Spec.AccessModes[0] != corev1.ReadWriteOncePod ||
		!requested.Equal(apiresource.MustParse("8Gi")) {
		t.Fatalf("runtime-state PVC did not use independent RWOP profile: %#v", runtimePVC.Spec)
	}
	controller := metav1.GetControllerOf(&runtimePVC)
	if controller == nil || controller.Kind != "T4Session" || controller.Name != session.Name || controller.UID != session.UID {
		t.Fatalf("runtime-state PVC owner = %#v", controller)
	}

	var pod corev1.Pod
	if err := c.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: controllers.SessionPodName(session)}, &pod); err != nil {
		t.Fatal(err)
	}
	podSecurity := pod.Spec.SecurityContext
	authoritySecurity := pod.Spec.Containers[0].SecurityContext
	shellSecurity := pod.Spec.Containers[1].SecurityContext
	credentialSecurity := pod.Spec.Containers[2].SecurityContext
	if podSecurity == nil || podSecurity.RunAsUser != nil ||
		podSecurity.FSGroup == nil || *podSecurity.FSGroup != 20001 ||
		podSecurity.FSGroupChangePolicy == nil || *podSecurity.FSGroupChangePolicy != corev1.FSGroupChangeOnRootMismatch ||
		podSecurity.SeccompProfile == nil || podSecurity.SeccompProfile.Type != corev1.SeccompProfileTypeRuntimeDefault ||
		authoritySecurity == nil || authoritySecurity.RunAsUser == nil || *authoritySecurity.RunAsUser != 10001 ||
		shellSecurity == nil || shellSecurity.RunAsUser == nil || *shellSecurity.RunAsUser != 10002 ||
		credentialSecurity == nil || credentialSecurity.RunAsUser == nil || *credentialSecurity.RunAsUser != 10003 ||
		authoritySecurity.RunAsGroup == nil || *authoritySecurity.RunAsGroup != 20001 ||
		shellSecurity.RunAsGroup == nil || *shellSecurity.RunAsGroup != 20001 ||
		credentialSecurity.RunAsGroup == nil || *credentialSecurity.RunAsGroup != 20001 {
		t.Fatalf("runtime principal uid/gid policy is unsafe: pod=%#v authority=%#v shell=%#v credential=%#v", podSecurity, authoritySecurity, shellSecurity, credentialSecurity)
	}
	for name, security := range map[string]*corev1.SecurityContext{"authority": authoritySecurity, "shell": shellSecurity, "credential": credentialSecurity} {
		if security.AllowPrivilegeEscalation == nil || *security.AllowPrivilegeEscalation ||
			security.ReadOnlyRootFilesystem == nil || !*security.ReadOnlyRootFilesystem ||
			security.RunAsNonRoot == nil || !*security.RunAsNonRoot ||
			security.Capabilities == nil || !reflect.DeepEqual(security.Capabilities.Drop, []corev1.Capability{"ALL"}) {
			t.Fatalf("%s container security policy is unsafe: %#v", name, security)
		}
	}
	if !hasMount(pod.Spec.Containers[0].VolumeMounts, "runtime-state", "/runtime-state") {
		t.Fatalf("runtime-state mount missing: %#v", pod.Spec.Containers[0].VolumeMounts)
	}
	volume := findVolume(pod.Spec.Volumes, "runtime-state")
	if volume == nil || volume.PersistentVolumeClaim == nil || volume.PersistentVolumeClaim.ClaimName != runtimePVC.Name {
		t.Fatalf("runtime-state volume = %#v", volume)
	}
	var got clusterv1alpha1.T4Session
	if err := c.Get(ctx, client.ObjectKeyFromObject(session), &got); err != nil {
		t.Fatal(err)
	}
	runtimeID := controllers.RuntimeStateFilesystemRoot(session)
	stateRoot := "/runtime-state/" + runtimeID
	shortRoot := "/run/t4/" + runtimeID
	expectedRuntimeEnv := map[string]string{
		"T4_RUNTIME_ID":           runtimeID,
		"T4_SESSION_STATE_ID":     runtimeID,
		"T4_WORKSPACE_ROOT":       "/workspace",
		"T4_SESSION_STATE_ROOT":   stateRoot,
		"T4_AUTHORITY_STATE_DIR":  stateRoot + "/authority",
		"T4_CMUX_STATE_DIR":       stateRoot + "/cmux",
		"T4_BROWSER_STATE_DIR":    stateRoot + "/browser",
		"T4_ARTIFACT_ROOT":        stateRoot + "/artifacts",
		"T4_PRIVATE_RUNTIME_DIR":  stateRoot + "/private",
		"T4_OMP_HOME":             stateRoot + "/home",
		"T4_HOST_RUNTIME_DIR":     shortRoot,
		"T4_CMUX_SOCKET_PATH":     shortRoot + "/c.sock",
		"T4_CMUX_SOCKET_MODE":     "0660",
		"T4_RUNTIME_GENERATION":   got.Status.RuntimeGeneration,
	}
	for name, want := range expectedRuntimeEnv {
		if got := findEnvValue(pod.Spec.Containers[0].Env, name); got != want {
			t.Fatalf("%s = %q, want controller-derived %q; env: %#v", name, got, want, pod.Spec.Containers[0].Env)
		}
	}
	if got := findEnvValue(pod.Spec.Containers[2].Env, "T4_GENERATION_AUTH_PATH"); got != "/run/t4-generation-auth/key" {
		t.Fatalf("credential broker generation path = %q", got)
	}
	if strings.HasPrefix(stateRoot, "/workspace/") || strings.HasPrefix(shortRoot, stateRoot+"/") {
		t.Fatalf("private runtime roots overlap shared workspace or durable state: state=%q short=%q", stateRoot, shortRoot)
	}
	workspaceVolume := findVolume(pod.Spec.Volumes, "workspace")
	if !hasMount(pod.Spec.Containers[0].VolumeMounts, "workspace", "/workspace") ||
		runtimePVC.Name == workspacePVC.Name ||
		workspaceVolume == nil || workspaceVolume.PersistentVolumeClaim == nil ||
		workspaceVolume.PersistentVolumeClaim.ClaimName != workspacePVC.Name {
		t.Fatalf("workspace and runtime-state mounts are not distinct: mounts=%#v volumes=%#v", pod.Spec.Containers[0].VolumeMounts, pod.Spec.Volumes)
	}
	generationAuthVolume := findVolume(pod.Spec.Volumes, "generation-auth")
	if generationAuthVolume == nil || generationAuthVolume.Secret == nil ||
		generationAuthVolume.Secret.SecretName != got.Status.GenerationSecretName ||
		len(generationAuthVolume.Secret.Items) != 1 ||
		generationAuthVolume.Secret.Items[0].Path != "key" ||
		generationAuthVolume.Secret.Items[0].Mode == nil ||
		*generationAuthVolume.Secret.Items[0].Mode != 0600 {
		t.Fatalf("generation auth is not projected as one private generation-bound credential: %#v", generationAuthVolume)
	}

	if got.Status.RuntimeStatePVCName != runtimePVC.Name ||
		got.Status.RuntimeStateStorageClassName != "runtime-rwo" ||
		got.Status.RuntimeStateCapacity == nil || !got.Status.RuntimeStateCapacity.Equal(apiresource.MustParse("8Gi")) ||
		got.Status.RuntimeStateFilesystemRoot != controllers.RuntimeStateFilesystemRoot(session) {
		t.Fatalf("runtime-state status did not converge: %#v", got.Status)
	}
}

func TestSessionDesiredStateRemovesOnlyPodRetainsRuntimeStateAndWakesOnce(t *testing.T) {
	for _, inactive := range []struct {
		state clusterv1alpha1.DesiredState
		phase clusterv1alpha1.InfrastructurePhase
	}{
		{state: clusterv1alpha1.DesiredStateSleeping, phase: clusterv1alpha1.InfrastructureSleeping},
		{state: clusterv1alpha1.DesiredStateStopped, phase: clusterv1alpha1.InfrastructureStopped},
	} {
		t.Run(string(inactive.state), func(t *testing.T) {
			ctx := context.Background()
			scheme := testScheme(t)
			workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
			workspace.UID = "workspace-uid"
			workspace.Status.PVCName = controllers.WorkspacePVCName(workspace)
			session := testSession()
			session.UID = types.UID("session-" + strings.ToLower(string(inactive.state)))
			c := fake.NewClientBuilder().WithScheme(scheme).
				WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
				WithObjects(testHost(), workspace, ownedWorkspacePVC(workspace), session).Build()
			r := configuredSessionReconciler(c, scheme)
			reconcileMany(t, 4, func() error {
				_, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
				return err
			})
			assertObjectCounts(t, c, 1, 1)
			bindRuntimeStateVolume(t, c, session)

			var current clusterv1alpha1.T4Session
			if err := c.Get(ctx, client.ObjectKeyFromObject(session), &current); err != nil {
				t.Fatal(err)
			}
			current.Spec.DesiredState = inactive.state
			if err := c.Update(ctx, &current); err != nil {
				t.Fatal(err)
			}
			reconcileMany(t, 3, func() error {
				_, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
				return err
			})
			assertObjectCounts(t, c, 0, 1)
			var retained corev1.PersistentVolumeClaim
			if err := c.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: controllers.RuntimeStatePVCName(session)}, &retained); err != nil {
				t.Fatalf("runtime-state PVC was not retained: %v", err)
			}
			if err := c.Get(ctx, client.ObjectKeyFromObject(session), &current); err != nil {
				t.Fatal(err)
			}
			available := findCondition(current.Status.Conditions, "Available")
			if current.Status.Phase != inactive.phase || current.Status.PodName != "" || available == nil || available.Status != metav1.ConditionFalse {
				t.Fatalf("inactive status = %#v", current.Status)
			}

			reconcileMany(t, 2, func() error {
				_, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
				return err
			})
			assertObjectCounts(t, c, 0, 1)

			current.Spec.DesiredState = clusterv1alpha1.DesiredStateRunning
			if err := c.Update(ctx, &current); err != nil {
				t.Fatal(err)
			}
			reconcileMany(t, 5, func() error {
				_, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
				return err
			})
			assertObjectCounts(t, c, 1, 1)
			var afterWake corev1.PersistentVolumeClaim
			if err := c.Get(ctx, client.ObjectKeyFromObject(&retained), &afterWake); err != nil {
				t.Fatal(err)
			}
			if afterWake.UID != retained.UID {
				t.Fatalf("wake replaced durable runtime-state PVC: %q -> %q", retained.UID, afterWake.UID)
			}
		})
	}
}

func TestSessionWakeWaitsForTerminatingReadyPodBeforeReplacement(t *testing.T) {
	ctx := context.Background()
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
	workspace.UID = "workspace-uid"
	workspace.Status.PVCName = controllers.WorkspacePVCName(workspace)
	session := testSession()
	session.UID = "session-uid"
	c := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
		WithObjects(testHost(), workspace, ownedWorkspacePVC(workspace), session).Build()
	r := configuredSessionReconciler(c, scheme)
	reconcileMany(t, 4, func() error {
		_, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
		return err
	})

	var pod corev1.Pod
	podKey := types.NamespacedName{Namespace: session.Namespace, Name: controllers.SessionPodName(session)}
	if err := c.Get(ctx, podKey, &pod); err != nil {
		t.Fatal(err)
	}
	bindRuntimeStateVolume(t, c, session)
	pod.Finalizers = []string{"test.t4.dev/hold-termination"}
	if err := c.Update(ctx, &pod); err != nil {
		t.Fatal(err)
	}
	if err := c.Get(ctx, podKey, &pod); err != nil {
		t.Fatal(err)
	}
	pod.Status.Phase = corev1.PodRunning
	pod.Status.Conditions = []corev1.PodCondition{{Type: corev1.PodReady, Status: corev1.ConditionTrue}}
	if err := c.Status().Update(ctx, &pod); err != nil {
		t.Fatal(err)
	}

	var current clusterv1alpha1.T4Session
	if err := c.Get(ctx, client.ObjectKeyFromObject(session), &current); err != nil {
		t.Fatal(err)
	}
	current.Spec.DesiredState = clusterv1alpha1.DesiredStateSleeping
	if err := c.Update(ctx, &current); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
		t.Fatal(err)
	}
	if err := c.Get(ctx, podKey, &pod); err != nil {
		t.Fatalf("held terminating Pod disappeared: %v", err)
	}
	if pod.DeletionTimestamp.IsZero() {
		t.Fatal("sleep did not begin deleting the held Pod")
	}

	if err := c.Get(ctx, client.ObjectKeyFromObject(session), &current); err != nil {
		t.Fatal(err)
	}
	current.Spec.DesiredState = clusterv1alpha1.DesiredStateRunning
	if err := c.Update(ctx, &current); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
		t.Fatal(err)
	}
	assertObjectCounts(t, c, 1, 1)
	if err := c.Get(ctx, client.ObjectKeyFromObject(session), &current); err != nil {
		t.Fatal(err)
	}
	available := findCondition(current.Status.Conditions, "Available")
	if current.Status.Phase != clusterv1alpha1.InfrastructurePending || available == nil || available.Status != metav1.ConditionFalse {
		t.Fatalf("terminating Ready Pod was published as available: %#v", current.Status)
	}

	if err := c.Get(ctx, podKey, &pod); err != nil {
		t.Fatal(err)
	}
	pod.Finalizers = nil
	if err := c.Update(ctx, &pod); err != nil && !apierrors.IsNotFound(err) {
		t.Fatal(err)
	}
	var remaining corev1.Pod
	if err := c.Get(ctx, podKey, &remaining); err == nil {
		if err := c.Delete(ctx, &remaining); err != nil && !apierrors.IsNotFound(err) {
			t.Fatal(err)
		}
	} else if !apierrors.IsNotFound(err) {
		t.Fatal(err)
	}
	reconcileMany(t, 4, func() error {
		_, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
		return err
	})
	assertObjectCounts(t, c, 1, 1)
	var replacement corev1.Pod
	if err := c.Get(ctx, podKey, &replacement); err != nil || !replacement.DeletionTimestamp.IsZero() {
		t.Fatalf("wake did not converge to one non-terminating replacement Pod: %#v, %v", replacement, err)
	}
}

func TestSessionRuntimeStateSnapshotDataSourceIsImmutableAndPublished(t *testing.T) {
	ctx := context.Background()
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
	workspace.UID = "workspace-uid"
	workspace.Status.PVCName = controllers.WorkspacePVCName(workspace)
	session := testSession()
	session.UID = "session-uid"
	snapshotSource, snapshot := readyRuntimeSnapshot(session, "runtime-checkpoint")
	session.Spec.RuntimeStateRestoreSnapshotRef = &clusterv1alpha1.VolumeSnapshotReference{Name: "runtime-checkpoint"}
	c := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
		WithObjects(testHost(), workspace, ownedWorkspacePVC(workspace), session, snapshotSource, snapshot, portableSnapshotClass()).Build()
	r := configuredSessionReconciler(c, scheme)
	reconcileMany(t, 3, func() error {
		_, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
		return err
	})

	var pvc corev1.PersistentVolumeClaim
	if err := c.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: controllers.RuntimeStatePVCName(session)}, &pvc); err != nil {
		t.Fatal(err)
	}
	if pvc.Spec.DataSource == nil || pvc.Spec.DataSource.APIGroup == nil || *pvc.Spec.DataSource.APIGroup != "snapshot.storage.k8s.io" ||
		pvc.Spec.DataSource.Kind != "VolumeSnapshot" || pvc.Spec.DataSource.Name != "runtime-checkpoint" {
		t.Fatalf("snapshot data source = %#v", pvc.Spec.DataSource)
	}
	var got clusterv1alpha1.T4Session
	if err := c.Get(ctx, client.ObjectKeyFromObject(session), &got); err != nil {
		t.Fatal(err)
	}
	if got.Status.RuntimeStateSnapshotRef == nil || got.Status.RuntimeStateSnapshotRef.Name != "runtime-checkpoint" {
		t.Fatalf("snapshot status = %#v", got.Status.RuntimeStateSnapshotRef)
	}
	if got.Status.RuntimeGeneration == "" || got.Status.RuntimeGeneration == "gen_source" {
		t.Fatalf("restore runtime generation = %q, want a new fenced generation", got.Status.RuntimeGeneration)
	}
}

func TestSessionRuntimeStatePVCConflictsFailClosedWithoutAdoptionOrDuplication(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*corev1.PersistentVolumeClaim)
		reason string
	}{
		{name: "ownership", reason: "RuntimeStatePVCOwnershipConflict", mutate: func(pvc *corev1.PersistentVolumeClaim) {
			pvc.OwnerReferences = nil
		}},
		{name: "immutable spec", reason: "RuntimeStatePVCSpecConflict", mutate: func(pvc *corev1.PersistentVolumeClaim) {
			pvc.Spec.StorageClassName = ptr("portable-rwx")
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			scheme := testScheme(t)
			workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
			workspace.UID = "workspace-uid"
			workspace.Status.PVCName = controllers.WorkspacePVCName(workspace)
			session := testSession()
			session.UID = "session-uid"
			runtimePVC := ownedRuntimeStatePVC(session)
			test.mutate(runtimePVC)
			before := runtimePVC.DeepCopy()
			c := fake.NewClientBuilder().WithScheme(scheme).
				WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
				WithObjects(testHost(), workspace, ownedWorkspacePVC(workspace), session, runtimePVC).Build()
			r := configuredSessionReconciler(c, scheme)
			reconcileMany(t, 2, func() error {
				_, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
				return err
			})
			assertObjectCounts(t, c, 0, 0)
			var after corev1.PersistentVolumeClaim
			if err := c.Get(ctx, client.ObjectKeyFromObject(runtimePVC), &after); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(before.Spec, after.Spec) || !reflect.DeepEqual(before.OwnerReferences, after.OwnerReferences) {
				t.Fatalf("conflicting runtime-state PVC was adopted or mutated: %#v", after)
			}
			var got clusterv1alpha1.T4Session
			if err := c.Get(ctx, client.ObjectKeyFromObject(session), &got); err != nil {
				t.Fatal(err)
			}
			available := findCondition(got.Status.Conditions, "Available")
			if got.Status.Phase != clusterv1alpha1.InfrastructureFailed || available == nil || available.Reason != test.reason {
				t.Fatalf("conflict status = %#v", got.Status)
			}
		})
	}
}

func TestSessionRuntimeStateAuthorityFailureClearsOnlyPVCBackedStatus(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*corev1.PersistentVolumeClaim)
	}{
		{name: "foreign owner", mutate: func(pvc *corev1.PersistentVolumeClaim) {
			pvc.OwnerReferences = nil
		}},
		{name: "authoritative spec mismatch", mutate: func(pvc *corev1.PersistentVolumeClaim) {
			pvc.Spec.StorageClassName = ptr("portable-rwx")
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			scheme := testScheme(t)
			workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
			workspace.UID = "workspace-uid"
			workspace.Status.PVCName = controllers.WorkspacePVCName(workspace)
			session := testSession()
			session.UID = "session-uid"
			snapshotSource, snapshot := readyRuntimeSnapshot(session, "checkpoint")
			session.Spec.RuntimeStateRestoreSnapshotRef = &clusterv1alpha1.VolumeSnapshotReference{Name: "checkpoint"}
			c := fake.NewClientBuilder().WithScheme(scheme).
				WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
				WithObjects(testHost(), workspace, ownedWorkspacePVC(workspace), session, snapshotSource, snapshot, portableSnapshotClass()).Build()
			r := configuredSessionReconciler(c, scheme)
			reconcileMany(t, 4, func() error {
				_, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
				return err
			})

			var converged clusterv1alpha1.T4Session
			if err := c.Get(ctx, client.ObjectKeyFromObject(session), &converged); err != nil {
				t.Fatal(err)
			}
			if converged.Status.RuntimeStatePVCName == "" || converged.Status.RuntimeStateStorageClassName == "" ||
				converged.Status.RuntimeStateCapacity == nil || converged.Status.RuntimeStateSnapshotRef == nil {
				t.Fatalf("runtime-state status did not first converge: %#v", converged.Status)
			}
			var cachedPVC corev1.PersistentVolumeClaim
			if err := c.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: controllers.RuntimeStatePVCName(session)}, &cachedPVC); err != nil {
				t.Fatal(err)
			}
			authoritativePVC := cachedPVC.DeepCopy()
			test.mutate(authoritativePVC)
			r.APIReader = &pvcOverrideReader{Reader: c, pvc: authoritativePVC}

			if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
				t.Fatal(err)
			}
			var failed clusterv1alpha1.T4Session
			if err := c.Get(ctx, client.ObjectKeyFromObject(session), &failed); err != nil {
				t.Fatal(err)
			}
			if failed.Status.RuntimeStatePVCName != "" ||
				failed.Status.RuntimeStateStorageClassName != "" ||
				failed.Status.RuntimeStateCapacity != nil ||
				failed.Status.RuntimeStateSnapshotRef != nil {
				t.Fatalf("stale PVC-backed status survived authority failure: %#v", failed.Status)
			}
			if failed.Status.RuntimeStateFilesystemRoot != converged.Status.RuntimeStateFilesystemRoot {
				t.Fatalf("deterministic filesystem root was incorrectly cleared: %q", failed.Status.RuntimeStateFilesystemRoot)
			}
			available := findCondition(failed.Status.Conditions, "Available")
			if failed.Status.Phase != clusterv1alpha1.InfrastructureFailed || available == nil {
				t.Fatalf("authority failure status = %#v", failed.Status)
			}
		})
	}
}

func TestLegacyEmptyDesiredStateDefaultsToIdempotentRunning(t *testing.T) {
	ctx := context.Background()
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
	workspace.UID = "workspace-uid"
	workspace.Status.PVCName = controllers.WorkspacePVCName(workspace)
	session := testSession()
	session.UID = "legacy-session-uid"
	session.Spec.DesiredState = ""
	c := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
		WithObjects(testHost(), workspace, ownedWorkspacePVC(workspace), session).Build()
	r := configuredSessionReconciler(c, scheme)
	reconcileMany(t, 8, func() error {
		_, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
		return err
	})
	assertObjectCounts(t, c, 1, 1)
	var runtimePVC corev1.PersistentVolumeClaim
	if err := c.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: controllers.RuntimeStatePVCName(session)}, &runtimePVC); err != nil {
		t.Fatal(err)
	}
}

func TestSessionOMPModeOmitsCredentialReferences(t *testing.T) {
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
	workspace.Status.PVCName = "workspace-a-data"
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: workspace.Status.PVCName, Namespace: "team"},
		Spec:       corev1.PersistentVolumeClaimSpec{StorageClassName: ptr("portable-rwx"), AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
		Status:     corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound},
	}
	session := testSession()
	c := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
		WithObjects(testHost(), workspace, pvc, session).Build()
	r := configuredSessionReconciler(c, scheme)
	reconcileMany(t, 2, func() error {
		_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
		return err
	})
	var pod corev1.Pod
	if err := c.Get(context.Background(), types.NamespacedName{Namespace: session.Namespace, Name: controllers.SessionPodName(session)}, &pod); err != nil {
		t.Fatal(err)
	}
	for _, container := range pod.Spec.Containers[:2] {
		for _, env := range container.Env {
			if len(container.Args) != 0 || env.ValueFrom != nil && env.ValueFrom.SecretKeyRef != nil {
				t.Fatalf("%s retained a credential reference: %#v", container.Name, env)
			}
			if env.Name == "T4_OMP_ALLOW_UNAUTHENTICATED" || strings.Contains(env.Name, "KUBERNETES") || env.Name == "T4_GENERATION_AUTH_PATH" {
				t.Fatalf("%s retained a credential mode sentinel: %#v", container.Name, env)
			}
		}
	}
}

func TestSessionRejectsUnownedDeterministicResources(t *testing.T) {
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
	workspace.Status.PVCName = "workspace-a-data"
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: workspace.Status.PVCName, Namespace: "team"},
		Spec:       corev1.PersistentVolumeClaimSpec{StorageClassName: ptr("portable-rwx"), AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
		Status:     corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound},
	}
	session := testSession()
	service := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: controllers.SessionServiceName(session), Namespace: "team"}}
	c := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}).
		WithObjects(testHost(), workspace, pvc, session, service).Build()
	r := configuredSessionReconciler(c, scheme)
	if _, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
		t.Fatal(err)
	}
	var got clusterv1alpha1.T4Session
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(session), &got); err != nil {
		t.Fatal(err)
	}
	condition := findCondition(got.Status.Conditions, "Available")
	if condition == nil || condition.Reason != "FenceUncertain" || got.Status.Phase != clusterv1alpha1.InfrastructureDegraded {
		t.Fatalf("collision did not fail closed: %#v/%q", condition, got.Status.Phase)
	}
	var pods corev1.PodList
	if err := c.List(context.Background(), &pods, client.InNamespace("team")); err != nil {
		t.Fatal(err)
	}
	if len(pods.Items) != 0 {
		t.Fatalf("collision created %d pods", len(pods.Items))
	}
}

func TestSessionRecreatesPodWhenImmutableDesiredStateChanges(t *testing.T) {
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
	workspace.Status.PVCName = "workspace-a-data"
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: workspace.Status.PVCName, Namespace: "team"},
		Spec:       corev1.PersistentVolumeClaimSpec{StorageClassName: ptr("portable-rwx"), AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
		Status:     corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound},
	}
	session := testSession()
	session.UID = "session-uid"
	c := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
		WithObjects(testHost(), workspace, pvc, session).Build()
	r := configuredSessionReconciler(c, scheme)
	r.RuntimeImage = testRuntimeImage
	reconcileMany(t, 2, func() error {
		_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
		return err
	})
	var original corev1.Pod
	if err := c.Get(context.Background(), types.NamespacedName{Namespace: "team", Name: controllers.SessionPodName(session)}, &original); err != nil {
		t.Fatal(err)
	}
	bindRuntimeStateVolume(t, c, session)
	originalHash := original.Annotations[clusterv1alpha1.SessionPodSpecHashAnnotation]
	r.RuntimeImage = otherTestRuntimeImage
	if _, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
		t.Fatal(err)
	}
	var deleted corev1.Pod
	if err := c.Get(context.Background(), types.NamespacedName{Namespace: "team", Name: controllers.SessionPodName(session)}, &deleted); !apierrors.IsNotFound(err) {
		t.Fatalf("outdated pod remains after immutable desired state changed: %v", err)
	}
	reconcileMany(t, 2, func() error {
		_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
		return err
	})
	var replacement corev1.Pod
	if err := c.Get(context.Background(), types.NamespacedName{Namespace: "team", Name: controllers.SessionPodName(session)}, &replacement); err != nil {
		t.Fatal(err)
	}
	if replacement.Spec.Containers[0].Image != r.RuntimeImage || replacement.Annotations[clusterv1alpha1.SessionPodSpecHashAnnotation] == originalHash {
		t.Fatalf("replacement pod did not converge: image=%q annotations=%#v", replacement.Spec.Containers[0].Image, replacement.Annotations)
	}
}

func TestSessionPodHashIncludesEveryOMPReference(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*controllers.SessionOMPConfig)
	}{
		{name: "ConfigMap", mutate: func(config *controllers.SessionOMPConfig) { config.ConfigMapName = "other-omp-config" }},
		{name: "models key", mutate: func(config *controllers.SessionOMPConfig) { config.ModelsKey = "other-models" }},
		{name: "settings key", mutate: func(config *controllers.SessionOMPConfig) { config.SettingsKey = "other-settings" }},
	} {
		t.Run(test.name, func(t *testing.T) {
			scheme := testScheme(t)
			workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
			workspace.Status.PVCName = "workspace-a-data"
			pvc := &corev1.PersistentVolumeClaim{
				ObjectMeta: metav1.ObjectMeta{Name: workspace.Status.PVCName, Namespace: "team"},
				Spec:       corev1.PersistentVolumeClaimSpec{StorageClassName: ptr("portable-rwx"), AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
				Status:     corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound},
			}
			session := testSession()
			session.UID = "session-uid"
			c := fake.NewClientBuilder().WithScheme(scheme).
				WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
				WithObjects(testHost(), workspace, pvc, session).Build()
			r := configuredSessionReconciler(c, scheme)
			reconcileMany(t, 2, func() error {
				_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
				return err
			})
			bindRuntimeStateVolume(t, c, session)
			test.mutate(&r.OMPConfig)
			if _, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
				t.Fatal(err)
			}
			var pod corev1.Pod
			if err := c.Get(context.Background(), types.NamespacedName{Namespace: session.Namespace, Name: controllers.SessionPodName(session)}, &pod); !apierrors.IsNotFound(err) {
				t.Fatalf("pod hash ignored changed %s reference: %v", test.name, err)
			}
		})
	}
}
func TestSessionRecreatesPodWhenOMPResourceVersionChanges(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(context.Context, client.Client) error
	}{
		{name: "ConfigMap", mutate: func(ctx context.Context, c client.Client) error {
			var configMap corev1.ConfigMap
			key := types.NamespacedName{Namespace: "team", Name: "omp-runtime-config"}
			if err := c.Get(ctx, key, &configMap); err != nil {
				return err
			}
			configMap.Data["provider-models"] = otherTestOMPModels
			return c.Update(ctx, &configMap)
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			scheme := testScheme(t)
			workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
			workspace.Status.PVCName = "workspace-a-data"
			pvc := &corev1.PersistentVolumeClaim{
				ObjectMeta: metav1.ObjectMeta{Name: workspace.Status.PVCName, Namespace: "team"},
				Spec:       corev1.PersistentVolumeClaimSpec{StorageClassName: ptr("portable-rwx"), AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
				Status:     corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound},
			}
			session := testSession()
			session.UID = "session-uid"
			c := fake.NewClientBuilder().WithScheme(scheme).
				WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
				WithObjects(testHost(), workspace, pvc, session).Build()
			r := configuredSessionReconciler(c, scheme)
			reconcileMany(t, 2, func() error {
				_, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
				return err
			})
			bindRuntimeStateVolume(t, c, session)
			if err := test.mutate(ctx, c); err != nil {
				t.Fatal(err)
			}
			if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
				t.Fatal(err)
			}
			var pod corev1.Pod
			if err := c.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: controllers.SessionPodName(session)}, &pod); !apierrors.IsNotFound(err) {
				t.Fatalf("pod retained stale %s resourceVersion: %v", test.name, err)
			}
		})
	}
}
func TestSessionRuntimeReferenceRevocationStopsAuthority(t *testing.T) {
	for _, test := range []struct {
		name       string
		revoke     func(context.Context, client.Client) error
		wantReason string
	}{
		{name: "ConfigMap deletion", wantReason: "OMPConfigMapNotFound", revoke: func(ctx context.Context, c client.Client) error {
			return c.Delete(ctx, &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "omp-runtime-config", Namespace: "team"}})
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			scheme := testScheme(t)
			workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
			workspace.Status.PVCName = "workspace-a-data"
			pvc := &corev1.PersistentVolumeClaim{
				ObjectMeta: metav1.ObjectMeta{Name: workspace.Status.PVCName, Namespace: "team"},
				Spec:       corev1.PersistentVolumeClaimSpec{StorageClassName: ptr("portable-rwx"), AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
				Status:     corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound},
			}
			session := testSession()
			session.UID = "session-uid"
			c := fake.NewClientBuilder().WithScheme(scheme).
				WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
				WithObjects(testHost(), workspace, pvc, session).Build()
			r := configuredSessionReconciler(c, scheme)
			reconcileMany(t, 2, func() error {
				_, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
				return err
			})
			markSessionCompositeReady(t, c, session)
			if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
				t.Fatal(err)
			}
			var running clusterv1alpha1.T4Session
			if err := c.Get(ctx, client.ObjectKeyFromObject(session), &running); err != nil {
				t.Fatal(err)
			}
			if running.Status.PodName == "" || running.Status.ServiceName == "" {
				t.Fatalf("running route was not published: %#v", running.Status)
			}
			if err := test.revoke(ctx, c); err != nil {
				t.Fatal(err)
			}
			if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
				t.Fatal(err)
			}
			var pod corev1.Pod
			if err := c.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: controllers.SessionPodName(session)}, &pod); !apierrors.IsNotFound(err) {
				t.Fatalf("revoked runtime retained authority pod: %v", err)
			}
			var failed clusterv1alpha1.T4Session
			if err := c.Get(ctx, client.ObjectKeyFromObject(session), &failed); err != nil {
				t.Fatal(err)
			}
			condition := findCondition(failed.Status.Conditions, "RuntimeConfigured")
			if failed.Status.PodName != "" || failed.Status.ServiceName != "" || failed.Status.Phase != clusterv1alpha1.InfrastructureFailed || condition == nil || condition.Reason != test.wantReason {
				t.Fatalf("revoked runtime remained routable: status=%#v condition=%#v", failed.Status, condition)
			}
		})
	}
}

func TestSessionStatusConflictAfterRoutePublicationWithdrawsSelector(t *testing.T) {
	ctx := context.Background()
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
	workspace.Status.PVCName = "workspace-a-data"
	workspacePVC := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: workspace.Status.PVCName, Namespace: "team"},
		Spec:       corev1.PersistentVolumeClaimSpec{StorageClassName: ptr("portable-rwx"), AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
		Status:     corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound},
	}
	session := testSession()
	session.UID = "session-uid"
	base := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
		WithObjects(testHost(), workspace, workspacePVC, session).Build()
	r := configuredSessionReconciler(base, scheme)
	reconcileMany(t, 2, func() error {
		_, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
		return err
	})
	markSessionCompositeReady(t, base, session)
	racing := &statusConflictAfterRoutePublicationClient{Client: base, sessionKey: client.ObjectKeyFromObject(session)}
	r.Client = racing
	if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); !apierrors.IsConflict(err) {
		t.Fatalf("route publication did not reach status conflict fixture: %v", err)
	}
	var service corev1.Service
	if err := base.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: controllers.SessionServiceName(session)}, &service); err != nil {
		t.Fatal(err)
	}
	if len(service.Spec.Selector) != 0 {
		t.Fatalf("status conflict left failed route publication enabled: %#v", service.Spec.Selector)
	}
}

func TestStaleRouteReadyCannotRepublishAfterLeaseChangeAndStatusConflict(t *testing.T) {
	ctx := context.Background()
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
	workspace.Status.PVCName = "workspace-a-data"
	workspacePVC := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: workspace.Status.PVCName, Namespace: "team"},
		Spec:       corev1.PersistentVolumeClaimSpec{StorageClassName: ptr("portable-rwx"), AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
		Status:     corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound},
	}
	session := testSession()
	session.UID = "session-uid"
	base := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
		WithObjects(testHost(), workspace, workspacePVC, session).Build()
	r := configuredSessionReconciler(base, scheme)
	reconcileMany(t, 2, func() error {
		_, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
		return err
	})
	markSessionCompositeReady(t, base, session)
	if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
		t.Fatal(err)
	}
	var current clusterv1alpha1.T4Session
	if err := base.Get(ctx, client.ObjectKeyFromObject(session), &current); err != nil {
		t.Fatal(err)
	}
	if condition := findCondition(current.Status.Conditions, "RouteReady"); condition == nil || condition.Status != metav1.ConditionTrue {
		t.Fatalf("fixture route was not ready: %#v", current.Status)
	}
	var lease coordinationv1.Lease
	if err := base.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: controllers.SessionWriterLeaseName(&current)}, &lease); err != nil {
		t.Fatal(err)
	}
	otherHolder := "other-pod-uid"
	lease.Spec.HolderIdentity = &otherHolder
	if err := base.Update(ctx, &lease); err != nil {
		t.Fatal(err)
	}
	racing := &statusConflictAfterRouteRevocationClient{Client: base, sessionKey: client.ObjectKeyFromObject(session)}
	r.Client = racing
	if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); !apierrors.IsConflict(err) {
		t.Fatalf("route revocation did not reach the status conflict fixture: %v", err)
	}
	var service corev1.Service
	if err := base.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: controllers.SessionServiceName(session)}, &service); err != nil {
		t.Fatal(err)
	}
	if len(service.Spec.Selector) != 0 {
		t.Fatalf("route remained published after Lease change: %#v", service.Spec.Selector)
	}
	if err := base.Get(ctx, client.ObjectKeyFromObject(session), &current); err != nil {
		t.Fatal(err)
	}
	if condition := findCondition(current.Status.Conditions, "RouteReady"); condition == nil || condition.Status != metav1.ConditionTrue {
		t.Fatalf("fixture did not preserve stale RouteReady across status conflict: %#v", current.Status.Conditions)
	}
	if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
		t.Fatal(err)
	}
	if err := base.Get(ctx, client.ObjectKeyFromObject(&service), &service); err != nil {
		t.Fatal(err)
	}
	if len(service.Spec.Selector) != 0 {
		t.Fatalf("stale RouteReady republished selector on retry: %#v", service.Spec.Selector)
	}
}

func TestSessionFailsClosedWhenOMPConfigMapIsMissing(t *testing.T) {
	for _, test := range []struct {
		name       string
		configMap  *corev1.ConfigMap
		wantReason string
	}{
		{name: "ConfigMap", wantReason: "OMPConfigMapNotFound"},
	} {
		t.Run(test.name, func(t *testing.T) {
			scheme := testScheme(t)
			workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
			workspace.Status.PVCName = "workspace-a-data"
			pvc := &corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Name: workspace.Status.PVCName, Namespace: "team"}, Spec: corev1.PersistentVolumeClaimSpec{StorageClassName: ptr("portable-rwx"), AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}}, Status: corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound}}
			session := testSession()
			objects := []client.Object{testHost(), rwxStorageClass(), workspace, pvc, session}
			if test.configMap != nil {
				objects = append(objects, test.configMap)
			}
			c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).WithObjects(objects...).Build()
			r := &controllers.SessionReconciler{Client: c, APIReader: c, Scheme: scheme, RuntimeImage: testRuntimeImage, OMPConfig: controllers.SessionOMPConfig{ConfigMapName: "omp-runtime-config", ModelsKey: "provider-models", SettingsKey: "agent-settings"}}
			if _, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
				t.Fatal(err)
			}
			assertObjectCounts(t, c, 0, 0)
			var got clusterv1alpha1.T4Session
			if err := c.Get(context.Background(), client.ObjectKeyFromObject(session), &got); err != nil {
				t.Fatal(err)
			}
			condition := findCondition(got.Status.Conditions, "RuntimeConfigured")
			if condition == nil || condition.Status != metav1.ConditionFalse || condition.Reason != test.wantReason {
				t.Fatalf("RuntimeConfigured = %#v, want False/%s", condition, test.wantReason)
			}
		})
	}
}

func TestSessionRecreatesExternallyExposedOwnedService(t *testing.T) {
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
	workspace.Status.PVCName = "workspace-a-data"
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: workspace.Status.PVCName, Namespace: "team"},
		Spec:       corev1.PersistentVolumeClaimSpec{StorageClassName: ptr("portable-rwx"), AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
		Status:     corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound},
	}
	session := testSession()
	session.UID = "session-uid"
	c := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
		WithObjects(testHost(), workspace, pvc, session).Build()
	r := configuredSessionReconciler(c, scheme)
	reconcileMany(t, 2, func() error {
		_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
		return err
	})
	serviceKey := types.NamespacedName{Namespace: "team", Name: controllers.SessionServiceName(session)}
	var service corev1.Service
	if err := c.Get(context.Background(), serviceKey, &service); err != nil {
		t.Fatal(err)
	}
	service.Spec.Type = corev1.ServiceTypeNodePort
	service.Spec.ExternalIPs = []string{"192.0.2.8"}
	service.Spec.Ports[0].NodePort = 32080
	if err := c.Update(context.Background(), &service); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
		t.Fatal(err)
	}
	if err := c.Get(context.Background(), serviceKey, &service); !apierrors.IsNotFound(err) {
		t.Fatalf("externally exposed Service was not deleted for safe recreation: %v", err)
	}
	reconcileMany(t, 2, func() error {
		_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
		return err
	})
	if err := c.Get(context.Background(), serviceKey, &service); err != nil {
		t.Fatal(err)
	}
	if service.Spec.Type != corev1.ServiceTypeClusterIP || len(service.Spec.ExternalIPs) != 0 || service.Spec.Ports[0].NodePort != 0 {
		t.Fatalf("recreated Service retains external exposure: %#v", service.Spec)
	}
}

func TestSessionRestoresRequiredPodSelectorLabelsBeforeAvailability(t *testing.T) {
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
	workspace.Status.PVCName = "workspace-a-data"
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: workspace.Status.PVCName, Namespace: "team"},
		Spec:       corev1.PersistentVolumeClaimSpec{StorageClassName: ptr("portable-rwx"), AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
		Status:     corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound},
	}
	session := testSession()
	session.UID = "session-uid"
	c := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
		WithObjects(testHost(), workspace, pvc, session).Build()
	r := configuredSessionReconciler(c, scheme)
	reconcileMany(t, 2, func() error {
		_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
		return err
	})
	podKey := types.NamespacedName{Namespace: "team", Name: controllers.SessionPodName(session)}
	var pod corev1.Pod
	if err := c.Get(context.Background(), podKey, &pod); err != nil {
		t.Fatal(err)
	}
	delete(pod.Labels, "cluster.t4.dev/session")
	if err := c.Update(context.Background(), &pod); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
		t.Fatal(err)
	}
	if err := c.Get(context.Background(), podKey, &pod); err != nil {
		t.Fatal(err)
	}
	if pod.Labels["cluster.t4.dev/session"] != controllers.SessionPodName(session) {
		t.Fatalf("required selector labels were not restored: %#v", pod.Labels)
	}
	var got clusterv1alpha1.T4Session
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(session), &got); err != nil {
		t.Fatal(err)
	}
	if got.Status.Phase == clusterv1alpha1.InfrastructureRunning {
		t.Fatal("session became available in the same reconcile that repaired endpoint labels")
	}
}
func TestWorkspaceDeletionRefusesForeignDeterministicPVC(t *testing.T) {
	for _, policy := range []clusterv1alpha1.RetentionPolicy{clusterv1alpha1.RetentionPolicyRetain, clusterv1alpha1.RetentionPolicyDelete} {
		for _, mismatch := range []string{"uid-annotation", "controller-owner", "foreign-non-controller-owner"} {
			t.Run(string(policy)+"/"+mismatch, func(t *testing.T) {
				scheme := testScheme(t)
				workspace := testWorkspace(policy)
				workspace.UID = "workspace-uid"
				workspace.Finalizers = []string{clusterv1alpha1.WorkspaceFinalizer}
				pvc := &corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{
					Name: controllers.WorkspacePVCName(workspace), Namespace: workspace.Namespace,
					Annotations: map[string]string{clusterv1alpha1.WorkspaceUIDAnnotation: string(workspace.UID)},
				}}
				if mismatch == "uid-annotation" {
					pvc.Annotations[clusterv1alpha1.WorkspaceUIDAnnotation] = "foreign-workspace-uid"
				} else if mismatch == "controller-owner" {
					pvc.OwnerReferences = []metav1.OwnerReference{{
						APIVersion: clusterv1alpha1.GroupVersion.String(), Kind: "T4Workspace", Name: "foreign", UID: "foreign-workspace-uid", Controller: ptr(true),
					}}
				} else {
					pvc.OwnerReferences = []metav1.OwnerReference{{
						APIVersion: "example.test/v1", Kind: "Foreign", Name: "foreign", UID: "foreign-uid",
					}}
				}
				expectedOwnerCount := len(pvc.OwnerReferences)
				c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Workspace{}).WithObjects(workspace, pvc).Build()
				if err := c.Delete(context.Background(), workspace); err != nil {
					t.Fatal(err)
				}
				r := &controllers.WorkspaceReconciler{Client: c, Scheme: scheme}
				if _, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(workspace)}); err != nil {
					t.Fatal(err)
				}
				var untouched corev1.PersistentVolumeClaim
				if err := c.Get(context.Background(), client.ObjectKeyFromObject(pvc), &untouched); err != nil {
					t.Fatalf("foreign deterministic PVC was deleted: %v", err)
				}
				if untouched.Annotations[clusterv1alpha1.RetainedPVCAnnotation] != "" || len(untouched.OwnerReferences) != expectedOwnerCount {
					t.Fatalf("foreign deterministic PVC was mutated: %#v", untouched.ObjectMeta)
				}
				var waiting clusterv1alpha1.T4Workspace
				if err := c.Get(context.Background(), client.ObjectKeyFromObject(workspace), &waiting); err != nil {
					t.Fatalf("workspace finalizer was removed on conflict: %v", err)
				}
				condition := findCondition(waiting.Status.Conditions, "Ready")
				if !contains(waiting.Finalizers, clusterv1alpha1.WorkspaceFinalizer) || condition == nil || condition.Reason != "CleanupOwnershipConflict" {
					t.Fatalf("workspace cleanup conflict not retained: %#v", waiting)
				}
			})
		}
	}
}

func TestSessionDeletionRefusesForeignDeterministicResources(t *testing.T) {
	for _, foreignKind := range []string{"Pod", "Service"} {
		t.Run(foreignKind, func(t *testing.T) {
			scheme := testScheme(t)
			session := testSession()
			session.UID = "session-uid"
			session.Finalizers = []string{clusterv1alpha1.SessionFinalizer}
			controller := true
			ownerReferences := []metav1.OwnerReference{{
				APIVersion: clusterv1alpha1.GroupVersion.String(), Kind: "T4Session", Name: session.Name, UID: session.UID, Controller: &controller,
			}}
			pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: controllers.SessionPodName(session), Namespace: session.Namespace, OwnerReferences: ownerReferences}}
			service := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: controllers.SessionServiceName(session), Namespace: session.Namespace, OwnerReferences: ownerReferences}}
			if foreignKind == "Pod" {
				pod.OwnerReferences = nil
			} else {
				service.OwnerReferences = nil
			}
			c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Session{}).WithObjects(session, pod, service).Build()
			beforePod := &corev1.Pod{}
			if err := c.Get(context.Background(), client.ObjectKeyFromObject(pod), beforePod); err != nil {
				t.Fatal(err)
			}
			beforeService := &corev1.Service{}
			if err := c.Get(context.Background(), client.ObjectKeyFromObject(service), beforeService); err != nil {
				t.Fatal(err)
			}
			if err := c.Delete(context.Background(), session); err != nil {
				t.Fatal(err)
			}
			r := &controllers.SessionReconciler{Client: c, Scheme: scheme}
			if _, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
				t.Fatal(err)
			}
			if foreignKind == "Pod" {
				assertObjectCounts(t, c, 1, 0)
			} else {
				assertObjectCounts(t, c, 0, 1)
			}
			if foreignKind == "Pod" {
				var got corev1.Pod
				if err := c.Get(context.Background(), client.ObjectKeyFromObject(pod), &got); err != nil {
					t.Fatalf("foreign Pod was deleted: %v", err)
				}
				if !reflect.DeepEqual(got.ObjectMeta, beforePod.ObjectMeta) || !reflect.DeepEqual(got.Spec, beforePod.Spec) {
					t.Fatalf("foreign Pod was mutated during finalizer cleanup: %#v", got)
				}
			} else {
				var got corev1.Service
				if err := c.Get(context.Background(), client.ObjectKeyFromObject(service), &got); err != nil {
					t.Fatalf("foreign Service was deleted: %v", err)
				}
				if !reflect.DeepEqual(got.ObjectMeta, beforeService.ObjectMeta) || !reflect.DeepEqual(got.Spec, beforeService.Spec) {
					t.Fatalf("foreign Service was mutated during finalizer cleanup: %#v", got)
				}
			}
			var waiting clusterv1alpha1.T4Session
			if err := c.Get(context.Background(), client.ObjectKeyFromObject(session), &waiting); err != nil {
				t.Fatalf("session finalizer was removed on cleanup conflict: %v", err)
			}
			condition := findCondition(waiting.Status.Conditions, "Available")
			if !contains(waiting.Finalizers, clusterv1alpha1.SessionFinalizer) || condition == nil || condition.Reason != "FenceUncertain" {
				t.Fatalf("session cleanup conflict not retained: %#v", waiting)
			}
		})
	}
}

func TestSessionDeletionUsesAuthoritativeChildReader(t *testing.T) {
	ctx := context.Background()
	scheme := testScheme(t)
	session := testSession()
	session.UID = "session-uid"
	session.Finalizers = []string{clusterv1alpha1.SessionFinalizer}
	pod, service := ownedSessionResources(session)
	pod.OwnerReferences = nil
	base := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Session{}).WithObjects(session, pod, service).Build()
	if err := base.Delete(ctx, session); err != nil {
		t.Fatal(err)
	}
	c := &createAlreadyExistsClient{Client: base, raceKind: "Pod", winner: pod, hideWinnerFromCache: true}
	r := configuredSessionReconciler(c, scheme)
	r.APIReader = base
	if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
		t.Fatal(err)
	}
	assertObjectCounts(t, base, 1, 0)
	var waiting clusterv1alpha1.T4Session
	if err := base.Get(ctx, client.ObjectKeyFromObject(session), &waiting); err != nil {
		t.Fatalf("session finalizer ignored authoritative Pod conflict: %v", err)
	}
	condition := findCondition(waiting.Status.Conditions, "Available")
	if condition == nil || condition.Reason != "FenceUncertain" || !contains(waiting.Finalizers, clusterv1alpha1.SessionFinalizer) {
		t.Fatalf("authoritative child conflict not retained: %#v", waiting)
	}
}

func TestSessionDeletionPreconditionsProtectSameNameReplacement(t *testing.T) {
	ctx := context.Background()
	scheme := testScheme(t)
	session := testSession()
	session.UID = "session-uid"
	session.Finalizers = []string{clusterv1alpha1.SessionFinalizer}
	pod, service := ownedSessionResources(session)
	pod.UID = "pod-uid-a"
	pod.ResourceVersion = "7"
	service.UID = "service-uid-a"
	service.ResourceVersion = "8"
	base := fake.NewClientBuilder().WithScheme(scheme).
		WithStatusSubresource(&clusterv1alpha1.T4Session{}).
		WithObjects(session, pod, service).Build()
	var observedPod corev1.Pod
	if err := base.Get(ctx, client.ObjectKeyFromObject(pod), &observedPod); err != nil {
		t.Fatal(err)
	}
	if observedPod.UID == "" || observedPod.ResourceVersion == "" {
		t.Fatalf("fake client discarded delete precondition identity: %#v", observedPod.ObjectMeta)
	}
	if err := base.Delete(ctx, session); err != nil {
		t.Fatal(err)
	}
	racingClient := &replaceBeforeDeleteClient{Client: base, raceKind: "Pod", replacementUID: "pod-uid-b"}
	r := configuredSessionReconciler(racingClient, scheme)
	if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); !apierrors.IsConflict(err) {
		t.Fatalf("same-name replacement did not conflict with the stale delete: %v", err)
	}
	if !racingClient.raced || racingClient.observedUID != observedPod.UID || racingClient.observedResourceVersion != observedPod.ResourceVersion {
		t.Fatalf("delete did not carry both observed preconditions: raced=%t uid=%q resourceVersion=%q", racingClient.raced, racingClient.observedUID, racingClient.observedResourceVersion)
	}
	var replacement corev1.Pod
	if err := base.Get(ctx, client.ObjectKeyFromObject(pod), &replacement); err != nil {
		t.Fatalf("same-name replacement Pod did not survive stale delete: %v", err)
	}
	if replacement.UID != racingClient.replacementUID {
		t.Fatalf("surviving Pod UID = %q, want replacement %q", replacement.UID, racingClient.replacementUID)
	}
	var waiting clusterv1alpha1.T4Session
	if err := base.Get(ctx, client.ObjectKeyFromObject(session), &waiting); err != nil {
		t.Fatalf("session finalizer advanced after stale child delete: %v", err)
	}
	available := findCondition(waiting.Status.Conditions, "Available")
	if !contains(waiting.Finalizers, clusterv1alpha1.SessionFinalizer) || waiting.Status.Phase != clusterv1alpha1.InfrastructureTerminating || available == nil || available.Reason != "Terminating" {
		t.Fatalf("session advanced after stale child delete: %#v", waiting)
	}
}

func TestSessionDependencyCleanupUsesAuthoritativeChildReader(t *testing.T) {
	ctx := context.Background()
	scheme := testScheme(t)
	session := testSession()
	session.UID = "session-uid"
	pod, service := ownedSessionResources(session)
	base := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.Pod{}).WithObjects(session, pod, service).Build()
	c := &createAlreadyExistsClient{Client: base, raceKind: "Pod", winner: pod, hideWinnerFromCache: true}
	r := configuredSessionReconciler(c, scheme)
	r.APIReader = base
	if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
		t.Fatal(err)
	}
	assertObjectCounts(t, base, 0, 0)
}

func TestSessionDeletionCleansResourcesBeforeFinalizer(t *testing.T) {
	scheme := testScheme(t)
	session := testSession()
	session.UID = "session-uid"
	session.Finalizers = []string{clusterv1alpha1.SessionFinalizer}
	controller := true
	ownerReferences := []metav1.OwnerReference{{
		APIVersion: clusterv1alpha1.GroupVersion.String(), Kind: "T4Session", Name: session.Name, UID: session.UID, Controller: &controller,
	}}
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: controllers.SessionPodName(session), Namespace: "team", OwnerReferences: ownerReferences}}
	service := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: controllers.SessionServiceName(session), Namespace: "team", OwnerReferences: ownerReferences}}
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Session{}).WithObjects(session, pod, service).Build()
	if err := c.Delete(context.Background(), session); err != nil {
		t.Fatal(err)
	}
	r := configuredSessionReconciler(c, scheme)
	reconcileMany(t, 3, func() error {
		_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
		return err
	})
	assertObjectCounts(t, c, 0, 0)
	var gone clusterv1alpha1.T4Session
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(session), &gone); !apierrors.IsNotFound(err) {
		t.Fatalf("session finalizer removed before cleanup completed: %v", err)
	}
}

func TestSessionDependencyRevocationCleansOwnedResourcesAndConvergesAfterRestart(t *testing.T) {
	for _, test := range []struct {
		name          string
		conditionType string
		wantReason    string
		revoke        func(context.Context, client.Client) error
	}{
		{name: "missing Host", conditionType: "HostReady", wantReason: "HostNotFound", revoke: func(ctx context.Context, c client.Client) error {
			return c.Delete(ctx, &clusterv1alpha1.T4ClusterHost{ObjectMeta: metav1.ObjectMeta{Name: "host-a", Namespace: "team"}})
		}},
		{name: "invalid Host runtime profile", conditionType: "RuntimeConfigured", wantReason: "RuntimeProfileNotAllowed", revoke: func(ctx context.Context, c client.Client) error {
			var host clusterv1alpha1.T4ClusterHost
			if err := c.Get(ctx, types.NamespacedName{Namespace: "team", Name: "host-a"}, &host); err != nil {
				return err
			}
			host.Spec.RuntimeProfiles = nil
			return c.Update(ctx, &host)
		}},
		{name: "missing Workspace", conditionType: "WorkspaceReady", wantReason: "WorkspaceNotFound", revoke: func(ctx context.Context, c client.Client) error {
			return c.Delete(ctx, &clusterv1alpha1.T4Workspace{ObjectMeta: metav1.ObjectMeta{Name: "workspace-a", Namespace: "team"}})
		}},
		{name: "mismatched Workspace Host", conditionType: "WorkspaceReady", wantReason: "HostMismatch", revoke: func(ctx context.Context, c client.Client) error {
			var workspace clusterv1alpha1.T4Workspace
			if err := c.Get(ctx, types.NamespacedName{Namespace: "team", Name: "workspace-a"}, &workspace); err != nil {
				return err
			}
			workspace.Spec.HostRef = "host-b"
			return c.Update(ctx, &workspace)
		}},
		{name: "missing OMP ConfigMap", conditionType: "RuntimeConfigured", wantReason: "OMPConfigMapNotFound", revoke: func(ctx context.Context, c client.Client) error {
			return c.Delete(ctx, &corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "omp-runtime-config", Namespace: "team"}})
		}},
		{name: "mismatched Host storage class", conditionType: "WorkspaceReady", wantReason: "StorageClassMismatch", revoke: func(ctx context.Context, c client.Client) error {
			otherClass := &storagev1.StorageClass{ObjectMeta: metav1.ObjectMeta{Name: "other-rwx", Annotations: map[string]string{clusterv1alpha1.RWXStorageClassAnnotation: string(corev1.ReadWriteMany)}}, Provisioner: "example.invalid/csi"}
			if err := c.Create(ctx, otherClass); err != nil {
				return err
			}
			var host clusterv1alpha1.T4ClusterHost
			if err := c.Get(ctx, types.NamespacedName{Namespace: "team", Name: "host-a"}, &host); err != nil {
				return err
			}
			host.Spec.StorageClassName = otherClass.Name
			host.Status.StorageCapabilities.WorkspaceStorageClassName = otherClass.Name
			return c.Update(ctx, &host)
		}},
		{name: "classless Workspace PVC", conditionType: "WorkspaceReady", wantReason: "StorageClassMismatch", revoke: func(ctx context.Context, c client.Client) error {
			var pvc corev1.PersistentVolumeClaim
			if err := c.Get(ctx, types.NamespacedName{Namespace: "team", Name: "workspace-a-data"}, &pvc); err != nil {
				return err
			}
			pvc.Spec.StorageClassName = nil
			return c.Update(ctx, &pvc)
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			scheme := testScheme(t)
			workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
			workspace.Status.PVCName = "workspace-a-data"
			pvc := &corev1.PersistentVolumeClaim{
				ObjectMeta: metav1.ObjectMeta{Name: workspace.Status.PVCName, Namespace: "team"},
				Spec:       corev1.PersistentVolumeClaimSpec{StorageClassName: ptr("portable-rwx"), AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
				Status:     corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound},
			}
			session := testSession()
			session.UID = "session-uid"
			foreignPod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "foreign-pod", Namespace: "team"}}
			foreignService := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "foreign-service", Namespace: "team"}}
			c := fake.NewClientBuilder().WithScheme(scheme).
				WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
				WithObjects(testHost(), workspace, pvc, session, foreignPod, foreignService).Build()
			r := configuredSessionReconciler(c, scheme)
			reconcileMany(t, 2, func() error {
				_, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
				return err
			})
			if err := test.revoke(ctx, c); err != nil {
				t.Fatal(err)
			}

			result, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
			if err != nil {
				t.Fatal(err)
			}
			if result.RequeueAfter <= 0 || result.RequeueAfter > 30*time.Second {
				t.Fatalf("revoked dependency requeue = %s, want bounded positive retry", result.RequeueAfter)
			}
			for _, object := range []client.Object{
				&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: controllers.SessionPodName(session), Namespace: session.Namespace}},
				&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: controllers.SessionServiceName(session), Namespace: session.Namespace}},
			} {
				if err := c.Get(ctx, client.ObjectKeyFromObject(object), object); !apierrors.IsNotFound(err) {
					t.Fatalf("owned stale %T remained after dependency revocation: %v", object, err)
				}
			}
			for _, object := range []client.Object{foreignPod.DeepCopy(), foreignService.DeepCopy()} {
				if err := c.Get(ctx, client.ObjectKeyFromObject(object), object); err != nil {
					t.Fatalf("unowned %T was removed: %v", object, err)
				}
			}

			var failed clusterv1alpha1.T4Session
			if err := c.Get(ctx, client.ObjectKeyFromObject(session), &failed); err != nil {
				t.Fatal(err)
			}
			condition := findCondition(failed.Status.Conditions, test.conditionType)
			available := findCondition(failed.Status.Conditions, "Available")
			if failed.Status.ObservedGeneration != failed.Generation || failed.Status.PodName != "" || failed.Status.ServiceName != "" || failed.Status.Phase != clusterv1alpha1.InfrastructureFailed ||
				condition == nil || condition.Status != metav1.ConditionFalse || condition.Reason != test.wantReason || condition.ObservedGeneration != failed.Generation ||
				available == nil || available.Status != metav1.ConditionFalse || available.Reason != test.wantReason || available.ObservedGeneration != failed.Generation {
				t.Fatalf("revoked session did not converge: status=%#v condition=%#v available=%#v", failed.Status, condition, available)
			}
			stableStatus := failed.Status
			restarted := *r
			reconcileMany(t, 2, func() error {
				_, err := restarted.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
				return err
			})
			if err := c.Get(ctx, client.ObjectKeyFromObject(session), &failed); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(failed.Status, stableStatus) {
				t.Fatalf("duplicate/restart reconciliation changed converged status: got %#v, want %#v", failed.Status, stableStatus)
			}
		})
	}
}
func TestWorkspaceHostStorageClassDriftFailsClosedWithoutRecreatingPVC(t *testing.T) {
	oldClass := "portable-rwx"
	for _, test := range []struct {
		name       string
		claimClass *string
	}{
		{name: "different class", claimClass: &oldClass},
		{name: "class omitted"},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			scheme := testScheme(t)
			workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
			workspace.UID = "workspace-uid"
			workspace.Status.ObservedGeneration = workspace.Generation
			workspace.Status.PVCName = controllers.WorkspacePVCName(workspace)
			workspace.Status.Phase = clusterv1alpha1.InfrastructureReady
			workspace.Status.Conditions = []metav1.Condition{
				{Type: "StorageReady", Status: metav1.ConditionTrue, Reason: controllers.ReasonStorageReady, ObservedGeneration: workspace.Generation},
				{Type: "Ready", Status: metav1.ConditionTrue, Reason: "PVCBound", ObservedGeneration: workspace.Generation},
			}
			pvc := &corev1.PersistentVolumeClaim{
				ObjectMeta: metav1.ObjectMeta{
					Name: workspace.Status.PVCName, Namespace: workspace.Namespace,
					Annotations:     map[string]string{clusterv1alpha1.WorkspaceUIDAnnotation: string(workspace.UID)},
					OwnerReferences: []metav1.OwnerReference{{APIVersion: clusterv1alpha1.GroupVersion.String(), Kind: "T4Workspace", Name: workspace.Name, UID: workspace.UID, Controller: ptr(true)}},
				},
				Spec:   corev1.PersistentVolumeClaimSpec{StorageClassName: test.claimClass, AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
				Status: corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound},
			}
			host := testHost()
			host.Spec.StorageClassName = "other-rwx"
			otherClass := &storagev1.StorageClass{ObjectMeta: metav1.ObjectMeta{Name: "other-rwx", Annotations: map[string]string{clusterv1alpha1.RWXStorageClassAnnotation: string(corev1.ReadWriteMany)}}, Provisioner: "example.invalid/csi"}
			c := fake.NewClientBuilder().WithScheme(scheme).
				WithIndex(&clusterv1alpha1.T4Session{}, testWorkspaceSessionRefIndexField, testIndexWorkspaceSessionByWorkspaceRef).
				WithStatusSubresource(&clusterv1alpha1.T4Workspace{}, &corev1.PersistentVolumeClaim{}).
				WithObjects(host, otherClass, workspace, pvc).Build()
			r := &controllers.WorkspaceReconciler{Client: c, Scheme: scheme}

			result, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(workspace)})
			if err != nil {
				t.Fatal(err)
			}
			if result.RequeueAfter <= 0 || result.RequeueAfter > 30*time.Second {
				t.Fatalf("storage drift requeue = %s, want bounded positive retry", result.RequeueAfter)
			}
			var got clusterv1alpha1.T4Workspace
			if err := c.Get(ctx, client.ObjectKeyFromObject(workspace), &got); err != nil {
				t.Fatal(err)
			}
			storageReady := findCondition(got.Status.Conditions, "StorageReady")
			ready := findCondition(got.Status.Conditions, "Ready")
			if got.Status.Phase != clusterv1alpha1.InfrastructureFailed || storageReady == nil || storageReady.Status != metav1.ConditionFalse || storageReady.Reason != "StorageClassMismatch" || ready == nil || ready.Status != metav1.ConditionFalse || ready.Reason != "StorageClassMismatch" {
				t.Fatalf("storage drift remained Ready: status=%#v StorageReady=%#v Ready=%#v", got.Status, storageReady, ready)
			}
			var retained corev1.PersistentVolumeClaim
			if err := c.Get(ctx, client.ObjectKeyFromObject(pvc), &retained); err != nil {
				t.Fatalf("storage drift removed the data PVC: %v", err)
			}
			if !reflect.DeepEqual(retained.Spec.StorageClassName, test.claimClass) {
				t.Fatalf("storage drift recreated or mutated PVC class: got %#v, want %#v", retained.Spec.StorageClassName, test.claimClass)
			}
		})
	}
}

func TestHostDependencyRecoveryReplacesFalseConditions(t *testing.T) {
	t.Run("Workspace", func(t *testing.T) {
		ctx := context.Background()
		scheme := testScheme(t)
		workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
		workspace.UID = "workspace-uid"
		c := fake.NewClientBuilder().WithScheme(scheme).
			WithIndex(&clusterv1alpha1.T4Session{}, testWorkspaceSessionRefIndexField, testIndexWorkspaceSessionByWorkspaceRef).
			WithStatusSubresource(&clusterv1alpha1.T4Workspace{}, &corev1.PersistentVolumeClaim{}).
			WithObjects(workspace).Build()
		r := &controllers.WorkspaceReconciler{Client: c, Scheme: scheme}
		if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(workspace)}); err != nil {
			t.Fatal(err)
		}
		if err := c.Create(ctx, testHost()); err != nil {
			t.Fatal(err)
		}
		if err := c.Create(ctx, rwxStorageClass()); err != nil {
			t.Fatal(err)
		}
		if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(workspace)}); err != nil {
			t.Fatal(err)
		}
		var pvc corev1.PersistentVolumeClaim
		if err := c.Get(ctx, types.NamespacedName{Namespace: workspace.Namespace, Name: controllers.WorkspacePVCName(workspace)}, &pvc); err != nil {
			t.Fatal(err)
		}
		pvc.Status.Phase = corev1.ClaimBound
		if err := c.Status().Update(ctx, &pvc); err != nil {
			t.Fatal(err)
		}
		if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(workspace)}); err != nil {
			t.Fatal(err)
		}
		var recovered clusterv1alpha1.T4Workspace
		if err := c.Get(ctx, client.ObjectKeyFromObject(workspace), &recovered); err != nil {
			t.Fatal(err)
		}
		hostReady := findCondition(recovered.Status.Conditions, "HostReady")
		if hostReady == nil || hostReady.Status != metav1.ConditionTrue || hostReady.ObservedGeneration != recovered.Generation {
			t.Fatalf("recovered Workspace retained stale HostReady: %#v", hostReady)
		}
	})

	t.Run("Session", func(t *testing.T) {
		ctx := context.Background()
		scheme := testScheme(t)
		workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
		workspace.Status.PVCName = "workspace-a-data"
		pvc := &corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Name: workspace.Status.PVCName, Namespace: workspace.Namespace}, Spec: corev1.PersistentVolumeClaimSpec{StorageClassName: ptr("portable-rwx"), AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}}, Status: corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound}}
		session := testSession()
		session.UID = "session-uid"
		c := fake.NewClientBuilder().WithScheme(scheme).
			WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
			WithObjects(workspace, pvc, session).Build()
		r := configuredSessionReconciler(c, scheme)
		if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
			t.Fatal(err)
		}
		if err := c.Create(ctx, testHost()); err != nil {
			t.Fatal(err)
		}
		reconcileMany(t, 2, func() error {
			_, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
			return err
		})
		var recovered clusterv1alpha1.T4Session
		if err := c.Get(ctx, client.ObjectKeyFromObject(session), &recovered); err != nil {
			t.Fatal(err)
		}
		hostReady := findCondition(recovered.Status.Conditions, "HostReady")
		if hostReady == nil || hostReady.Status != metav1.ConditionTrue || hostReady.ObservedGeneration != recovered.Generation {
			t.Fatalf("recovered Session retained stale HostReady: %#v", hostReady)
		}
	})

	t.Run("static runtime failure", func(t *testing.T) {
		ctx := context.Background()
		scheme := testScheme(t)
		session := testSession()
		session.Status.ObservedGeneration = session.Generation
		session.Status.Phase = clusterv1alpha1.InfrastructureFailed
		session.Status.Conditions = []metav1.Condition{{Type: "HostReady", Status: metav1.ConditionFalse, Reason: "HostNotFound", ObservedGeneration: session.Generation}}
		c := fake.NewClientBuilder().WithScheme(scheme).
			WithStatusSubresource(&clusterv1alpha1.T4Session{}).
			WithObjects(testHost(), session).Build()
		r := configuredSessionReconciler(c, scheme)
		r.RuntimeImage = "registry.example/session:latest"
		if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
			t.Fatal(err)
		}
		var failed clusterv1alpha1.T4Session
		if err := c.Get(ctx, client.ObjectKeyFromObject(session), &failed); err != nil {
			t.Fatal(err)
		}
		hostReady := findCondition(failed.Status.Conditions, "HostReady")
		if hostReady == nil || hostReady.Status != metav1.ConditionUnknown || hostReady.Reason != "NotEvaluated" || hostReady.ObservedGeneration != failed.Generation {
			t.Fatalf("static runtime failure retained stale HostReady: %#v", hostReady)
		}
	})
}
func TestWorkspaceFailureRevokesPublishedPVCAuthorityAndRefreshesConditions(t *testing.T) {
	for _, test := range []struct {
		name              string
		objects           func(*clusterv1alpha1.T4Workspace) []client.Object
		wantHostStatus    metav1.ConditionStatus
		wantStorageReason string
	}{
		{
			name: "missing Host",
			objects: func(workspace *clusterv1alpha1.T4Workspace) []client.Object {
				return []client.Object{workspace}
			},
			wantHostStatus:    metav1.ConditionFalse,
			wantStorageReason: "NotEvaluated",
		},
		{
			name: "missing StorageClass",
			objects: func(workspace *clusterv1alpha1.T4Workspace) []client.Object {
				return []client.Object{testHost(), workspace}
			},
			wantHostStatus:    metav1.ConditionTrue,
			wantStorageReason: controllers.ReasonStorageClassNotFound,
		},
		{
			name: "non-RWX StorageClass",
			objects: func(workspace *clusterv1alpha1.T4Workspace) []client.Object {
				class := rwxStorageClass()
				class.Annotations = nil
				return []client.Object{testHost(), class, workspace}
			},
			wantHostStatus:    metav1.ConditionTrue,
			wantStorageReason: controllers.ReasonStorageClassNotRWX,
		},
		{
			name: "PVC class drift",
			objects: func(workspace *clusterv1alpha1.T4Workspace) []client.Object {
				pvc := ownedWorkspacePVC(workspace)
				pvc.Spec.StorageClassName = ptr("old-rwx")
				return []client.Object{testHost(), rwxStorageClass(), workspace, pvc}
			},
			wantHostStatus:    metav1.ConditionTrue,
			wantStorageReason: controllers.ReasonStorageClassMismatch,
		},
		{
			name: "PVC ownership conflict",
			objects: func(workspace *clusterv1alpha1.T4Workspace) []client.Object {
				pvc := ownedWorkspacePVC(workspace)
				pvc.OwnerReferences = []metav1.OwnerReference{{APIVersion: "example.test/v1", Kind: "Foreign", Name: "foreign", UID: "foreign-uid", Controller: ptr(true)}}
				return []client.Object{testHost(), rwxStorageClass(), workspace, pvc}
			},
			wantHostStatus:    metav1.ConditionTrue,
			wantStorageReason: "PVCOwnershipConflict",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			scheme := testScheme(t)
			workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
			workspace.UID = "workspace-uid"
			workspace.Generation = 7
			workspace.Status.ObservedGeneration = 6
			workspace.Status.PVCName = controllers.WorkspacePVCName(workspace)
			workspace.Status.PVCPhase = corev1.ClaimBound
			workspace.Status.Capacity = apiresource.MustParse("10Gi")
			workspace.Status.Phase = clusterv1alpha1.InfrastructureReady
			workspace.Status.Conditions = []metav1.Condition{
				{Type: "HostReady", Status: metav1.ConditionTrue, Reason: "Stale", ObservedGeneration: 6},
				{Type: "StorageReady", Status: metav1.ConditionTrue, Reason: "Stale", ObservedGeneration: 6},
				{Type: "Ready", Status: metav1.ConditionTrue, Reason: "Stale", ObservedGeneration: 6},
			}
			c := fake.NewClientBuilder().WithScheme(scheme).
				WithIndex(&clusterv1alpha1.T4Session{}, testWorkspaceSessionRefIndexField, testIndexWorkspaceSessionByWorkspaceRef).
				WithStatusSubresource(&clusterv1alpha1.T4Workspace{}, &corev1.PersistentVolumeClaim{}).
				WithObjects(test.objects(workspace)...).Build()
			r := &controllers.WorkspaceReconciler{Client: c, Scheme: scheme}
			if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(workspace)}); err != nil {
				t.Fatal(err)
			}
			var failed clusterv1alpha1.T4Workspace
			if err := c.Get(ctx, client.ObjectKeyFromObject(workspace), &failed); err != nil {
				t.Fatal(err)
			}
			if failed.Status.PVCName != "" || failed.Status.PVCPhase != "" || !failed.Status.Capacity.IsZero() {
				t.Fatalf("failed Workspace retained PVC authority: %#v", failed.Status)
			}
			hostReady := findCondition(failed.Status.Conditions, "HostReady")
			storageReady := findCondition(failed.Status.Conditions, "StorageReady")
			ready := findCondition(failed.Status.Conditions, "Ready")
			if hostReady == nil || hostReady.Status != test.wantHostStatus || hostReady.ObservedGeneration != failed.Generation ||
				storageReady == nil || storageReady.Status == metav1.ConditionTrue || storageReady.Reason != test.wantStorageReason || storageReady.ObservedGeneration != failed.Generation ||
				ready == nil || ready.Status != metav1.ConditionFalse || ready.ObservedGeneration != failed.Generation {
				t.Fatalf("failure conditions are stale: HostReady=%#v StorageReady=%#v Ready=%#v", hostReady, storageReady, ready)
			}
		})
	}
}

func TestSessionRejectsWorkspacePVCWithoutExactIdentityAndOwnership(t *testing.T) {
	for _, test := range []struct {
		name      string
		mutatePVC func(*clusterv1alpha1.T4Workspace, *corev1.PersistentVolumeClaim)
	}{
		{name: "foreign deterministic PVC", mutatePVC: func(_ *clusterv1alpha1.T4Workspace, pvc *corev1.PersistentVolumeClaim) {
			pvc.OwnerReferences = []metav1.OwnerReference{{APIVersion: "example.test/v1", Kind: "Foreign", Name: "foreign", UID: "foreign-uid", Controller: ptr(true)}}
		}},
		{name: "tampered Workspace status name", mutatePVC: func(workspace *clusterv1alpha1.T4Workspace, pvc *corev1.PersistentVolumeClaim) {
			workspace.Status.PVCName = "foreign-data"
			pvc.Name = workspace.Status.PVCName
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			scheme := testScheme(t)
			workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
			workspace.UID = "workspace-uid"
			workspace.Status.PVCName = controllers.WorkspacePVCName(workspace)
			pvc := ownedWorkspacePVC(workspace)
			test.mutatePVC(workspace, pvc)
			session := testSession()
			session.UID = "session-uid"
			pod, service := ownedSessionResources(session)
			c := fake.NewClientBuilder().WithScheme(scheme).
				WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
				WithObjects(testHost(), workspace, pvc, session, pod, service).Build()
			r := configuredSessionReconciler(c, scheme)
			if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
				t.Fatal(err)
			}
			assertObjectCounts(t, c, 0, 0)
			var failed clusterv1alpha1.T4Session
			if err := c.Get(ctx, client.ObjectKeyFromObject(session), &failed); err != nil {
				t.Fatal(err)
			}
			condition := findCondition(failed.Status.Conditions, "WorkspaceReady")
			if failed.Status.PodName != "" || failed.Status.ServiceName != "" || condition == nil || condition.Status != metav1.ConditionFalse || condition.ObservedGeneration != failed.Generation {
				t.Fatalf("untrusted Workspace PVC retained session authority: status=%#v WorkspaceReady=%#v", failed.Status, condition)
			}
		})
	}
}

func TestSessionFailureAndPendingRefreshEveryCondition(t *testing.T) {
	t.Run("failure", func(t *testing.T) {
		ctx := context.Background()
		scheme := testScheme(t)
		session := testSession()
		session.Generation = 8
		session.Status.ObservedGeneration = 7
		session.Status.Conditions = staleSessionConditions(7)
		c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Session{}).WithObjects(session).Build()
		r := configuredSessionReconciler(c, scheme)
		if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
			t.Fatal(err)
		}
		var failed clusterv1alpha1.T4Session
		if err := c.Get(ctx, client.ObjectKeyFromObject(session), &failed); err != nil {
			t.Fatal(err)
		}
		assertCurrentSessionConditions(t, &failed, map[string]metav1.ConditionStatus{
			"HostReady": metav1.ConditionFalse, "WorkspaceReady": metav1.ConditionUnknown, "RuntimeConfigured": metav1.ConditionUnknown,
			"Fenced": metav1.ConditionTrue, "StorageReady": metav1.ConditionUnknown, "RouteReady": metav1.ConditionFalse,
			"TicketsRevoked": metav1.ConditionTrue, "GenerationAuthRevoked": metav1.ConditionTrue, "Available": metav1.ConditionFalse,
		})
	})

	t.Run("pending", func(t *testing.T) {
		ctx := context.Background()
		scheme := testScheme(t)
		workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
		workspace.UID = "workspace-uid"
		workspace.Status.PVCName = controllers.WorkspacePVCName(workspace)
		pvc := ownedWorkspacePVC(workspace)
		session := testSession()
		session.UID = "session-uid"
		session.Generation = 8
		session.Status.ObservedGeneration = 7
		session.Status.Conditions = staleSessionConditions(7)
		_, service := ownedSessionResources(session)
		service.Spec.Type = corev1.ServiceTypeNodePort
		service.Spec.Ports = []corev1.ServicePort{{Name: "host", Port: 8787, NodePort: 32080}}
		c := fake.NewClientBuilder().WithScheme(scheme).
			WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
			WithObjects(testHost(), workspace, pvc, session, service).Build()
		r := configuredSessionReconciler(c, scheme)
		if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
			t.Fatal(err)
		}
		var pending clusterv1alpha1.T4Session
		if err := c.Get(ctx, client.ObjectKeyFromObject(session), &pending); err != nil {
			t.Fatal(err)
		}
		assertCurrentSessionConditions(t, &pending, map[string]metav1.ConditionStatus{
			"HostReady": metav1.ConditionTrue, "WorkspaceReady": metav1.ConditionTrue, "RuntimeConfigured": metav1.ConditionTrue,
			"Fenced": metav1.ConditionTrue, "StorageReady": metav1.ConditionUnknown, "RouteReady": metav1.ConditionFalse,
			"TicketsRevoked": metav1.ConditionTrue, "GenerationAuthRevoked": metav1.ConditionFalse, "Available": metav1.ConditionFalse,
		})
	})
}

func TestSessionResourcesWithAnyForeignOwnerFailClosed(t *testing.T) {
	for _, path := range []string{"normal", "dependency-cleanup"} {
		for _, kind := range []string{"Pod", "Service"} {
			t.Run(path+"/"+kind, func(t *testing.T) {
				ctx := context.Background()
				scheme := testScheme(t)
				session := testSession()
				session.UID = "session-uid"
				pod, service := ownedSessionResources(session)
				foreignOwner := metav1.OwnerReference{APIVersion: "example.test/v1", Kind: "Foreign", Name: "foreign", UID: "foreign-uid"}
				if kind == "Pod" {
					pod.OwnerReferences = append(pod.OwnerReferences, foreignOwner)
				} else {
					service.OwnerReferences = append(service.OwnerReferences, foreignOwner)
				}
				objects := []client.Object{session, pod, service}
				if path == "normal" {
					workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
					workspace.UID = "workspace-uid"
					workspace.Status.PVCName = controllers.WorkspacePVCName(workspace)
					objects = append(objects, testHost(), workspace, ownedWorkspacePVC(workspace))
					generation := "gen_active-generation"
					pod.UID = "active-pod-uid"
					service.Spec.Selector = map[string]string{"route": "active"}
					session.Status.RuntimeGeneration = generation
					session.Status.GenerationSecretEpoch = generation
					session.Status.GenerationSecretName = controllers.GenerationAuthSecretName(session, generation)
					session.Status.FenceState = clusterv1alpha1.RuntimeFenceProven
					session.Status.PodName = pod.Name
					session.Status.PodUID = string(pod.UID)
					session.Status.ServiceName = service.Name
					controller := true
					owner := metav1.OwnerReference{APIVersion: clusterv1alpha1.GroupVersion.String(), Kind: "T4Session", Name: session.Name, UID: session.UID, Controller: &controller}
					immutable := true
					auth := &corev1.Secret{
						ObjectMeta: metav1.ObjectMeta{
							Name: session.Status.GenerationSecretName, Namespace: session.Namespace,
							Annotations:     map[string]string{"cluster.t4.dev/runtime-generation": generation},
							OwnerReferences: []metav1.OwnerReference{owner},
						},
						Immutable: &immutable,
						Type:      corev1.SecretTypeOpaque,
						Data:      map[string][]byte{"key": make([]byte, 32)},
					}
					holder := string(pod.UID)
					lease := &coordinationv1.Lease{
						ObjectMeta: metav1.ObjectMeta{Name: controllers.SessionWriterLeaseName(session), Namespace: session.Namespace, Annotations: map[string]string{"cluster.t4.dev/runtime-generation": generation}, OwnerReferences: []metav1.OwnerReference{owner}},
						Spec:       coordinationv1.LeaseSpec{HolderIdentity: &holder},
					}
					objects = append(objects, auth, lease)
				}
				c := fake.NewClientBuilder().WithScheme(scheme).
					WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
					WithObjects(objects...).Build()
				r := configuredSessionReconciler(c, scheme)
				beforePod := pod.DeepCopy()
				beforeService := service.DeepCopy()
				if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
					t.Fatal(err)
				}
				if kind == "Pod" {
					var got corev1.Pod
					if err := c.Get(ctx, client.ObjectKeyFromObject(pod), &got); err != nil {
						t.Fatalf("foreign-owned Pod was deleted: %v", err)
					}
					if !reflect.DeepEqual(got.ObjectMeta, beforePod.ObjectMeta) || !reflect.DeepEqual(got.Spec, beforePod.Spec) {
						t.Fatalf("Pod with foreign OwnerReference was mutated: %#v", got)
					}
				} else {
					var got corev1.Service
					if err := c.Get(ctx, client.ObjectKeyFromObject(service), &got); err != nil {
						t.Fatalf("foreign-owned Service was deleted: %v", err)
					}
					if !reflect.DeepEqual(got.ObjectMeta, beforeService.ObjectMeta) || !reflect.DeepEqual(got.Spec, beforeService.Spec) {
						t.Fatalf("Service with foreign OwnerReference was mutated: %#v", got)
					}
				}
				var sibling client.Object
				if kind == "Pod" {
					sibling = &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: controllers.SessionServiceName(session), Namespace: session.Namespace}}
				} else {
					sibling = &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: controllers.SessionPodName(session), Namespace: session.Namespace}}
				}
				err := c.Get(ctx, client.ObjectKeyFromObject(sibling), sibling)
				if path == "normal" && err != nil {
					t.Fatalf("owned sibling was deleted during active uncertain ownership: %v", err)
				}
				if path == "dependency-cleanup" && !apierrors.IsNotFound(err) {
					t.Fatalf("owned sibling survived dependency cleanup: %v", err)
				}
				var failed clusterv1alpha1.T4Session
				if err := c.Get(ctx, client.ObjectKeyFromObject(session), &failed); err != nil {
					t.Fatal(err)
				}
				available := findCondition(failed.Status.Conditions, "Available")
				if available == nil || available.Status != metav1.ConditionFalse || available.Reason != "FenceUncertain" ||
					failed.Status.Phase != clusterv1alpha1.InfrastructureDegraded || failed.Status.FenceState != clusterv1alpha1.RuntimeFenceUncertain {
					t.Fatalf("foreign owner did not produce FenceUncertain: status=%#v available=%#v", failed.Status, available)
				}
				if path == "normal" {
					for _, object := range []client.Object{
						&corev1.Secret{ObjectMeta: metav1.ObjectMeta{Name: session.Status.GenerationSecretName, Namespace: session.Namespace}},
						&coordinationv1.Lease{ObjectMeta: metav1.ObjectMeta{Name: controllers.SessionWriterLeaseName(session), Namespace: session.Namespace}},
					} {
						if err := c.Get(ctx, client.ObjectKeyFromObject(object), object); !apierrors.IsNotFound(err) {
							t.Fatalf("owned generation authority survived ownership conflict: %T err=%v", object, err)
						}
					}
				}
				if path == "normal" {
					assertCurrentSessionConditions(t, &failed, map[string]metav1.ConditionStatus{
						"HostReady": metav1.ConditionUnknown, "WorkspaceReady": metav1.ConditionUnknown, "RuntimeConfigured": metav1.ConditionUnknown, "Available": metav1.ConditionFalse,
					})
				}
			})
		}
	}
}

func TestSessionCreateAlreadyExistsRefetchesForeignWinner(t *testing.T) {
	for _, kind := range []string{"Pod", "Service"} {
		t.Run(kind, func(t *testing.T) {
			ctx := context.Background()
			scheme := testScheme(t)
			workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
			workspace.UID = "workspace-uid"
			workspace.Status.PVCName = controllers.WorkspacePVCName(workspace)
			session := testSession()
			session.UID = "session-uid"
			pod, service := ownedSessionResources(session)
			objects := []client.Object{testHost(), workspace, ownedWorkspacePVC(workspace), session}
			if kind == "Pod" {
				objects = append(objects, service)
			} else {
				generation := "gen_current-generation"
				session.Status.RuntimeGeneration = generation
				session.Status.GenerationSecretEpoch = generation
				session.Status.GenerationSecretName = controllers.GenerationAuthSecretName(session, generation)
				session.Status.FenceState = clusterv1alpha1.RuntimeFenceProven
				immutable := true
				auth := &corev1.Secret{
					ObjectMeta: metav1.ObjectMeta{
						Name: session.Status.GenerationSecretName, Namespace: session.Namespace,
						Annotations:     map[string]string{"cluster.t4.dev/runtime-generation": generation},
						OwnerReferences: append([]metav1.OwnerReference(nil), pod.OwnerReferences...),
					},
					Immutable: &immutable,
					Type:      corev1.SecretTypeOpaque,
					Data:      map[string][]byte{"key": make([]byte, 32)},
				}
				objects = append(objects, pod, auth)
			}
			base := fake.NewClientBuilder().WithScheme(scheme).
				WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
				WithObjects(objects...).Build()
			c := &createAlreadyExistsClient{Client: base, raceKind: kind, hideWinnerFromCache: true}
			r := configuredSessionReconciler(c, scheme)
			r.APIReader = base
			if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
				t.Fatal(err)
			}
			if c.winner == nil {
				t.Fatalf("%s create race was not exercised", kind)
			}
			if kind == "Pod" {
				var got corev1.Pod
				if err := base.Get(ctx, client.ObjectKeyFromObject(c.winner), &got); err != nil {
					t.Fatalf("foreign Pod winner was deleted: %v", err)
				}
				want := c.winner.(*corev1.Pod)
				if !reflect.DeepEqual(got.ObjectMeta, want.ObjectMeta) || !reflect.DeepEqual(got.Spec, want.Spec) {
					t.Fatalf("foreign Pod winner was mutated: %#v", got)
				}
				assertObjectCounts(t, base, 1, 1)
			} else {
				var got corev1.Service
				if err := base.Get(ctx, client.ObjectKeyFromObject(c.winner), &got); err != nil {
					t.Fatalf("foreign Service winner was deleted: %v", err)
				}
				want := c.winner.(*corev1.Service)
				if !reflect.DeepEqual(got.ObjectMeta, want.ObjectMeta) || !reflect.DeepEqual(got.Spec, want.Spec) {
					t.Fatalf("foreign Service winner was mutated: %#v", got)
				}
				assertObjectCounts(t, base, 1, 1)
			}
			var failed clusterv1alpha1.T4Session
			if err := base.Get(ctx, client.ObjectKeyFromObject(session), &failed); err != nil {
				t.Fatal(err)
			}
			assertCurrentSessionConditions(t, &failed, map[string]metav1.ConditionStatus{
				"HostReady": metav1.ConditionUnknown, "WorkspaceReady": metav1.ConditionUnknown, "RuntimeConfigured": metav1.ConditionUnknown, "Available": metav1.ConditionFalse,
			})
			available := findCondition(failed.Status.Conditions, "Available")
			if available.Reason != "FenceUncertain" || failed.Status.FenceState != clusterv1alpha1.RuntimeFenceUncertain {
				t.Fatalf("ownership race did not fail closed: status=%#v available=%#v", failed.Status, available)
			}
		})
	}
}
func TestWorkspaceTerminalPVCFailuresRevokePublishedAuthority(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*corev1.PersistentVolumeClaim)
		reason string
	}{
		{name: "Bound without RWX", reason: "PVCNotRWX", mutate: func(pvc *corev1.PersistentVolumeClaim) {
			pvc.Spec.AccessModes = []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce}
		}},
		{name: "Lost", reason: "PVCLost", mutate: func(pvc *corev1.PersistentVolumeClaim) { pvc.Status.Phase = corev1.ClaimLost }},
	} {
		t.Run(test.name, func(t *testing.T) {
			ctx := context.Background()
			scheme := testScheme(t)
			workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
			workspace.UID = "workspace-uid"
			pvc := ownedWorkspacePVC(workspace)
			test.mutate(pvc)
			c := fake.NewClientBuilder().WithScheme(scheme).
				WithIndex(&clusterv1alpha1.T4Session{}, testWorkspaceSessionRefIndexField, testIndexWorkspaceSessionByWorkspaceRef).
				WithStatusSubresource(&clusterv1alpha1.T4Workspace{}, &corev1.PersistentVolumeClaim{}).
				WithObjects(testHost(), rwxStorageClass(), workspace, pvc).Build()
			r := &controllers.WorkspaceReconciler{Client: c, Scheme: scheme}
			if _, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(workspace)}); err != nil {
				t.Fatal(err)
			}
			var failed clusterv1alpha1.T4Workspace
			if err := c.Get(ctx, client.ObjectKeyFromObject(workspace), &failed); err != nil {
				t.Fatal(err)
			}
			storageReady := findCondition(failed.Status.Conditions, "StorageReady")
			ready := findCondition(failed.Status.Conditions, "Ready")
			if failed.Status.PVCName != "" || failed.Status.PVCPhase != "" || !failed.Status.Capacity.IsZero() ||
				storageReady == nil || storageReady.Status != metav1.ConditionFalse || storageReady.Reason != test.reason || storageReady.ObservedGeneration != failed.Generation ||
				ready == nil || ready.Status != metav1.ConditionFalse || ready.Reason != test.reason || ready.ObservedGeneration != failed.Generation {
				t.Fatalf("terminal PVC failure retained authority: status=%#v StorageReady=%#v Ready=%#v", failed.Status, storageReady, ready)
			}
		})
	}
}

func ownedWorkspacePVC(workspace *clusterv1alpha1.T4Workspace) *corev1.PersistentVolumeClaim {
	return &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name: controllers.WorkspacePVCName(workspace), Namespace: workspace.Namespace,
			Annotations:     map[string]string{clusterv1alpha1.WorkspaceUIDAnnotation: string(workspace.UID)},
			OwnerReferences: []metav1.OwnerReference{{APIVersion: clusterv1alpha1.GroupVersion.String(), Kind: "T4Workspace", Name: workspace.Name, UID: workspace.UID, Controller: ptr(true)}},
		},
		Spec:   corev1.PersistentVolumeClaimSpec{StorageClassName: ptr("portable-rwx"), AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
		Status: corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound},
	}
}

func ownedSessionResources(session *clusterv1alpha1.T4Session) (*corev1.Pod, *corev1.Service) {
	owner := metav1.OwnerReference{APIVersion: clusterv1alpha1.GroupVersion.String(), Kind: "T4Session", Name: session.Name, UID: session.UID, Controller: ptr(true)}
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: controllers.SessionPodName(session), Namespace: session.Namespace, OwnerReferences: []metav1.OwnerReference{owner}}}
	service := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: controllers.SessionServiceName(session), Namespace: session.Namespace, OwnerReferences: []metav1.OwnerReference{owner}}, Spec: corev1.ServiceSpec{Type: corev1.ServiceTypeClusterIP}}
	return pod, service
}

func ownedRuntimeStatePVC(session *clusterv1alpha1.T4Session) *corev1.PersistentVolumeClaim {
	owner := metav1.OwnerReference{APIVersion: clusterv1alpha1.GroupVersion.String(), Kind: "T4Session", Name: session.Name, UID: session.UID, Controller: ptr(true)}
	return &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: controllers.RuntimeStatePVCName(session), Namespace: session.Namespace, OwnerReferences: []metav1.OwnerReference{owner}},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes:      []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce},
			StorageClassName: ptr("runtime-rwo"),
			VolumeMode:       ptr(corev1.PersistentVolumeFilesystem),
			Resources: corev1.VolumeResourceRequirements{
				Requests: corev1.ResourceList{corev1.ResourceStorage: apiresource.MustParse("8Gi")},
			},
		},
	}
}

func bindRuntimeStateVolume(t *testing.T, c client.Client, session *clusterv1alpha1.T4Session) {
	t.Helper()
	var pvc corev1.PersistentVolumeClaim
	key := types.NamespacedName{Namespace: session.Namespace, Name: controllers.RuntimeStatePVCName(session)}
	if err := c.Get(context.Background(), key, &pvc); err != nil {
		t.Fatal(err)
	}
	if pvc.Spec.VolumeName != "" {
		return
	}
	pvc.Spec.VolumeName = "runtime-pv-" + session.Name
	if err := c.Update(context.Background(), &pvc); err != nil {
		t.Fatal(err)
	}
}

func markSessionCompositeReady(t *testing.T, c client.Client, session *clusterv1alpha1.T4Session) {
	t.Helper()
	ctx := context.Background()
	var current clusterv1alpha1.T4Session
	if err := c.Get(ctx, client.ObjectKeyFromObject(session), &current); err != nil {
		t.Fatal(err)
	}
	var pod corev1.Pod
	podKey := types.NamespacedName{Namespace: session.Namespace, Name: controllers.SessionPodName(session)}
	if err := c.Get(ctx, podKey, &pod); err != nil {
		t.Fatal(err)
	}
	if pod.UID == "" {
		pod.UID = types.UID("ready-pod-uid")
		if err := c.Update(ctx, &pod); err != nil {
			t.Fatal(err)
		}
		if err := c.Get(ctx, podKey, &pod); err != nil {
			t.Fatal(err)
		}
	}
	generation := current.Status.RuntimeGeneration
	pod.Status.Phase = corev1.PodRunning
	pod.Status.Conditions = []corev1.PodCondition{
		{Type: corev1.PodReady, Status: corev1.ConditionTrue},
		{Type: corev1.PodScheduled, Status: corev1.ConditionTrue},
		{Type: "cluster.t4.dev/RuntimeStateMounted", Status: corev1.ConditionTrue, Message: generation},
		{Type: "cluster.t4.dev/RuntimeGenerationReady", Status: corev1.ConditionTrue, Message: generation},
		{Type: "cluster.t4.dev/InternalAuthReady", Status: corev1.ConditionTrue, Message: generation},
		{Type: "cluster.t4.dev/OMPAuthorityReady", Status: corev1.ConditionTrue, Message: generation},
		{Type: "cluster.t4.dev/CmuxV10Ready", Status: corev1.ConditionTrue, Message: generation},
	}
	if current.Spec.GUIEnabled {
		pod.Status.Conditions = append(pod.Status.Conditions, corev1.PodCondition{Type: "cluster.t4.dev/BrowserReady", Status: corev1.ConditionTrue, Message: generation})
	}
	if err := c.Status().Update(ctx, &pod); err != nil {
		t.Fatal(err)
	}
	var pvc corev1.PersistentVolumeClaim
	pvcKey := types.NamespacedName{Namespace: session.Namespace, Name: current.Status.RuntimeStatePVCName}
	if err := c.Get(ctx, pvcKey, &pvc); err != nil {
		t.Fatal(err)
	}
	pvc.Spec.VolumeName = "runtime-pv-" + session.Name
	if err := c.Update(ctx, &pvc); err != nil {
		t.Fatal(err)
	}
	if err := c.Get(ctx, pvcKey, &pvc); err != nil {
		t.Fatal(err)
	}
	pvc.Status.Phase = corev1.ClaimBound
	if err := c.Status().Update(ctx, &pvc); err != nil {
		t.Fatal(err)
	}
	var lease coordinationv1.Lease
	leaseKey := types.NamespacedName{Namespace: session.Namespace, Name: controllers.SessionWriterLeaseName(&current)}
	if err := c.Get(ctx, leaseKey, &lease); err != nil {
		t.Fatal(err)
	}
	holder := string(pod.UID)
	lease.Spec.HolderIdentity = &holder
	if err := c.Update(ctx, &lease); err != nil {
		t.Fatal(err)
	}
}

func staleSessionConditions(generation int64) []metav1.Condition {
	return []metav1.Condition{
		{Type: "HostReady", Status: metav1.ConditionTrue, Reason: "Stale", ObservedGeneration: generation},
		{Type: "WorkspaceReady", Status: metav1.ConditionTrue, Reason: "Stale", ObservedGeneration: generation},
		{Type: "RuntimeConfigured", Status: metav1.ConditionTrue, Reason: "Stale", ObservedGeneration: generation},
		{Type: "Fenced", Status: metav1.ConditionFalse, Reason: "Stale", ObservedGeneration: generation},
		{Type: "StorageReady", Status: metav1.ConditionTrue, Reason: "Stale", ObservedGeneration: generation},
		{Type: "RouteReady", Status: metav1.ConditionTrue, Reason: "Stale", ObservedGeneration: generation},
		{Type: "TicketsRevoked", Status: metav1.ConditionFalse, Reason: "Stale", ObservedGeneration: generation},
		{Type: "GenerationAuthRevoked", Status: metav1.ConditionFalse, Reason: "Stale", ObservedGeneration: generation},
		{Type: "Available", Status: metav1.ConditionTrue, Reason: "Stale", ObservedGeneration: generation},
	}
}

func assertCurrentSessionConditions(t *testing.T, session *clusterv1alpha1.T4Session, want map[string]metav1.ConditionStatus) {
	t.Helper()
	for conditionType, status := range want {
		condition := findCondition(session.Status.Conditions, conditionType)
		if condition == nil || condition.Status != status || condition.ObservedGeneration != session.Generation {
			t.Fatalf("%s = %#v, want %s at generation %d", conditionType, condition, status, session.Generation)
		}
	}
}

func configuredSessionReconciler(c client.Client, scheme *runtime.Scheme) *controllers.SessionReconciler {
	for _, object := range []client.Object{
		&corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "omp-runtime-config", Namespace: "team"}, Data: map[string]string{
			"provider-models": testOMPModels, "agent-settings": testOMPSettings, "other-models": otherTestOMPModels, "other-settings": otherTestOMPSettings,
		}},
		&corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: "other-omp-config", Namespace: "team"}, Data: map[string]string{
			"provider-models": testOMPModels, "agent-settings": testOMPSettings, "other-models": otherTestOMPModels, "other-settings": otherTestOMPSettings,
		}},
		rwxStorageClass(),
		runtimeStateStorageClass(),
	} {
		if err := c.Create(context.Background(), object); err != nil && !apierrors.IsAlreadyExists(err) {
			panic(err)
		}
	}
	var host clusterv1alpha1.T4ClusterHost
	hostKey := types.NamespacedName{Namespace: "team", Name: "host-a"}
	if err := c.Get(context.Background(), hostKey, &host); err == nil && host.Spec.RuntimeStateStorageProfile == nil {
		host.Spec.RuntimeStateStorageProfile = &clusterv1alpha1.RuntimeStateStorageProfile{
			StorageClassName: "runtime-rwo",
			Size:             apiresource.MustParse("8Gi"),
		}
		if err := c.Update(context.Background(), &host); err != nil {
			panic(err)
		}
	}
	return &controllers.SessionReconciler{
		Client:       c,
		APIReader:    c,
		Scheme:       scheme,
		RuntimeImage: testRuntimeImage,
		OMPConfig: controllers.SessionOMPConfig{
			ConfigMapName: "omp-runtime-config",
			ModelsKey:     "provider-models",
			SettingsKey:   "agent-settings",
		},
	}
}

func testScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	scheme := runtime.NewScheme()
	for _, add := range []func(*runtime.Scheme) error{corev1.AddToScheme, coordinationv1.AddToScheme, rbacv1.AddToScheme, storagev1.AddToScheme, clusterv1alpha1.AddToScheme} {
		if err := add(scheme); err != nil {
			t.Fatal(err)
		}
	}
	return scheme
}

func testHost() *clusterv1alpha1.T4ClusterHost {
	return &clusterv1alpha1.T4ClusterHost{
		ObjectMeta: metav1.ObjectMeta{Name: "host-a", Namespace: "team", UID: "host-uid"},
		Spec: clusterv1alpha1.T4ClusterHostSpec{
			StorageClassName: "portable-rwx", RuntimeProfiles: []string{"default"},
			RuntimeStateStorageProfile: &clusterv1alpha1.RuntimeStateStorageProfile{StorageClassName: "runtime-rwo", Size: apiresource.MustParse("8Gi"), AccessMode: clusterv1alpha1.RuntimeStateAccessModeReadWriteOncePod, VolumeSnapshotClassName: "portable-snapshots"},
		},
		Status: clusterv1alpha1.T4ClusterHostStatus{StorageCapabilities: &clusterv1alpha1.StorageCapabilities{
			WorkspaceReadWriteMany: clusterv1alpha1.StorageCapabilityObservation{State: clusterv1alpha1.StorageCapabilitySupported},
			RuntimeStateReattach: clusterv1alpha1.StorageCapabilityObservation{State: clusterv1alpha1.StorageCapabilitySupported},
			VolumeSnapshots: clusterv1alpha1.StorageCapabilityObservation{State: clusterv1alpha1.StorageCapabilitySupported},
			SnapshotDataSource: clusterv1alpha1.StorageCapabilityObservation{State: clusterv1alpha1.StorageCapabilitySupported},
			WorkspaceStorageClassName: "portable-rwx",
			RuntimeStateStorageClassName: "runtime-rwo",
			VolumeSnapshotClassName: "portable-snapshots",
		}},
	}
}

func readyRuntimeSnapshot(session *clusterv1alpha1.T4Session, name string) (*corev1.PersistentVolumeClaim, *unstructured.Unstructured) {
	sourcePVC := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: name + "-source", Namespace: session.Namespace},
		Spec: corev1.PersistentVolumeClaimSpec{StorageClassName: ptr("runtime-rwo")},
	}
	snapshot := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "snapshot.storage.k8s.io/v1",
		"kind": "VolumeSnapshot",
		"metadata": map[string]any{"name": name, "namespace": session.Namespace},
		"spec": map[string]any{
			"volumeSnapshotClassName": "portable-snapshots",
			"source": map[string]any{"persistentVolumeClaimName": sourcePVC.Name},
		},
		"status": map[string]any{"readyToUse": true},
	}}
	snapshot.SetGroupVersionKind(schema.GroupVersionKind{Group: "snapshot.storage.k8s.io", Version: "v1", Kind: "VolumeSnapshot"})
	snapshot.SetLabels(map[string]string{
		clusterv1alpha1.SnapshotSourceLabel: "runtime-state",
		clusterv1alpha1.SnapshotConsistencyLabel: string(clusterv1alpha1.SnapshotConsistencyQuiesced),
		clusterv1alpha1.SnapshotGenerationLabel: "gen_source",
	})
	snapshot.SetAnnotations(map[string]string{"cluster.t4.dev/source-public-id": session.Spec.PublicID})
	return sourcePVC, snapshot
}
func portableSnapshotClass() *unstructured.Unstructured {
	snapshotClass := &unstructured.Unstructured{Object: map[string]any{
		"apiVersion": "snapshot.storage.k8s.io/v1",
		"kind": "VolumeSnapshotClass",
		"metadata": map[string]any{"name": "portable-snapshots"},
		"driver": "example.invalid/csi",
		"deletionPolicy": "Retain",
	}}
	snapshotClass.SetGroupVersionKind(schema.GroupVersionKind{Group: "snapshot.storage.k8s.io", Version: "v1", Kind: "VolumeSnapshotClass"})
	return snapshotClass
}


func rwxStorageClass() *storagev1.StorageClass {
	return &storagev1.StorageClass{
		ObjectMeta:  metav1.ObjectMeta{Name: "portable-rwx", Annotations: map[string]string{clusterv1alpha1.RWXStorageClassAnnotation: string(corev1.ReadWriteMany)}},
		Provisioner: "example.invalid/csi",
	}
}

func runtimeStateStorageClass() *storagev1.StorageClass {
	return &storagev1.StorageClass{
		ObjectMeta:  metav1.ObjectMeta{Name: "runtime-rwo"},
		Provisioner: "example.invalid/csi",
	}
}

func testWorkspace(policy clusterv1alpha1.RetentionPolicy) *clusterv1alpha1.T4Workspace {
	return &clusterv1alpha1.T4Workspace{
		ObjectMeta: metav1.ObjectMeta{Name: "workspace-a", Namespace: "team", Generation: 3},
		Spec: clusterv1alpha1.T4WorkspaceSpec{
			HostRef: "host-a", DisplayName: "Workspace A", Owner: "team-a", Size: apiresource.MustParse("10Gi"), RetentionPolicy: policy,
		},
	}
}

func testSession() *clusterv1alpha1.T4Session {
	return &clusterv1alpha1.T4Session{
		ObjectMeta: metav1.ObjectMeta{Name: "session-a", Namespace: "team", Generation: 2},
		Spec:       clusterv1alpha1.T4SessionSpec{PublicID: "runtime-a", HostRef: "host-a", WorkspaceRef: "workspace-a", Title: "Session A", RuntimeProfile: "default", GUIEnabled: true},
	}
}

func reconcileMany(t *testing.T, count int, reconcile func() error) {
	t.Helper()
	for i := 0; i < count; i++ {
		if err := reconcile(); err != nil {
			t.Fatalf("reconcile %d: %v", i+1, err)
		}
	}
}

func assertObjectCounts(t *testing.T, c client.Client, wantPods, wantServices int) {
	t.Helper()
	var pods corev1.PodList
	var services corev1.ServiceList
	if err := c.List(context.Background(), &pods, client.InNamespace("team")); err != nil {
		t.Fatal(err)
	}
	if err := c.List(context.Background(), &services, client.InNamespace("team")); err != nil {
		t.Fatal(err)
	}
	if len(pods.Items) != wantPods || len(services.Items) != wantServices {
		t.Fatalf("pods/services = %d/%d, want %d/%d", len(pods.Items), len(services.Items), wantPods, wantServices)
	}
}

func findCondition(conditions []metav1.Condition, conditionType string) *metav1.Condition {
	for i := range conditions {
		if conditions[i].Type == conditionType {
			return &conditions[i]
		}
	}
	return nil
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func hasMount(mounts []corev1.VolumeMount, name, path string) bool {
	for _, mount := range mounts {
		if mount.Name == name && mount.MountPath == path {
			return true
		}
	}
	return false
}

func findVolume(volumes []corev1.Volume, name string) *corev1.VolumeSource {
	for i := range volumes {
		if volumes[i].Name == name {
			return &volumes[i].VolumeSource
		}
	}
	return nil
}

func findEnvValue(env []corev1.EnvVar, name string) string {
	for i := range env {
		if env[i].Name == name {
			return env[i].Value
		}
	}
	return ""
}

func hasReadOnlyMount(mounts []corev1.VolumeMount, name, path string) bool {
	for _, mount := range mounts {
		if mount.Name == name && mount.MountPath == path && mount.ReadOnly {
			return true
		}
	}
	return false
}

type pvcOverrideReader struct {
	client.Reader
	pvc *corev1.PersistentVolumeClaim
}

func (r *pvcOverrideReader) Get(ctx context.Context, key client.ObjectKey, object client.Object, options ...client.GetOption) error {
	if pvc, ok := object.(*corev1.PersistentVolumeClaim); ok && key == client.ObjectKeyFromObject(r.pvc) {
		r.pvc.DeepCopyInto(pvc)
		return nil
	}
	return r.Reader.Get(ctx, key, object, options...)
}

type createAlreadyExistsClient struct {
	client.Client
	raceKind            string
	winner              client.Object
	hideWinnerFromCache bool
}

type replaceBeforeDeleteClient struct {
	client.Client
	raceKind                string
	replacementUID          types.UID
	raced                   bool
	observedUID             types.UID
	observedResourceVersion string
}

func (c *replaceBeforeDeleteClient) Delete(ctx context.Context, object client.Object, options ...client.DeleteOption) error {
	if c.raced {
		return c.Client.Delete(ctx, object, options...)
	}
	if _, isPod := object.(*corev1.Pod); !isPod || c.raceKind != "Pod" {
		return c.Client.Delete(ctx, object, options...)
	}
	deleteOptions := (&client.DeleteOptions{}).ApplyOptions(options)
	if deleteOptions.Preconditions != nil {
		if deleteOptions.Preconditions.UID != nil {
			c.observedUID = *deleteOptions.Preconditions.UID
		}
		if deleteOptions.Preconditions.ResourceVersion != nil {
			c.observedResourceVersion = *deleteOptions.Preconditions.ResourceVersion
		}
	}
	c.raced = true
	if err := c.Client.Delete(ctx, object); err != nil {
		return err
	}
	replacement := object.DeepCopyObject().(client.Object)
	replacement.SetUID(c.replacementUID)
	replacement.SetResourceVersion("")
	replacement.SetDeletionTimestamp(nil)
	replacement.SetFinalizers(nil)
	replacement.SetOwnerReferences(nil)
	if err := c.Client.Create(ctx, replacement); err != nil {
		return err
	}
	return apierrors.NewConflict(schema.GroupResource{Resource: "pods"}, object.GetName(), errors.New("delete preconditions no longer match replacement"))
}

func (c *createAlreadyExistsClient) Get(ctx context.Context, key client.ObjectKey, object client.Object, options ...client.GetOption) error {
	if c.hideWinnerFromCache && c.winner != nil && key == client.ObjectKeyFromObject(c.winner) {
		switch object.(type) {
		case *corev1.Pod:
			if c.raceKind == "Pod" {
				return apierrors.NewNotFound(schema.GroupResource{Resource: "pods"}, key.Name)
			}
		case *corev1.Service:
			if c.raceKind == "Service" {
				return apierrors.NewNotFound(schema.GroupResource{Resource: "services"}, key.Name)
			}
		case *corev1.PersistentVolumeClaim:
			if c.raceKind == "PVC" {
				return apierrors.NewNotFound(schema.GroupResource{Resource: "persistentvolumeclaims"}, key.Name)
			}
		}
	}
	return c.Client.Get(ctx, key, object, options...)
}

func (c *createAlreadyExistsClient) Create(ctx context.Context, object client.Object, options ...client.CreateOption) error {
	var winner client.Object
	switch object := object.(type) {
	case *corev1.Pod:
		if c.raceKind == "Pod" {
			winner = object.DeepCopy()
		}
	case *corev1.Service:
		if c.raceKind == "Service" {
			winner = object.DeepCopy()
		}
	case *corev1.PersistentVolumeClaim:
		if c.raceKind == "PVC" {
			winner = object.DeepCopy()
		}
	}
	if winner == nil || c.winner != nil {
		return c.Client.Create(ctx, object, options...)
	}
	winner.SetOwnerReferences(nil)
	if err := c.Client.Create(ctx, winner, options...); err != nil {
		return err
	}
	c.winner = winner.DeepCopyObject().(client.Object)
	return apierrors.NewAlreadyExists(schema.GroupResource{Resource: strings.ToLower(c.raceKind) + "s"}, object.GetName())
}

type statusConflictAfterRoutePublicationClient struct {
	client.Client
	sessionKey client.ObjectKey
	raced      bool
}

func (c *statusConflictAfterRoutePublicationClient) Update(ctx context.Context, object client.Object, options ...client.UpdateOption) error {
	if err := c.Client.Update(ctx, object, options...); err != nil {
		return err
	}
	service, isService := object.(*corev1.Service)
	if c.raced || !isService || len(service.Spec.Selector) == 0 {
		return nil
	}
	c.raced = true
	var session clusterv1alpha1.T4Session
	if err := c.Client.Get(ctx, c.sessionKey, &session); err != nil {
		return err
	}
	session.Status.Phase = clusterv1alpha1.InfrastructureStarting
	return c.Client.Status().Update(ctx, &session)
}

type statusConflictAfterRouteRevocationClient struct {
	client.Client
	sessionKey client.ObjectKey
	raced      bool
}

func (c *statusConflictAfterRouteRevocationClient) Update(ctx context.Context, object client.Object, options ...client.UpdateOption) error {
	if err := c.Client.Update(ctx, object, options...); err != nil {
		return err
	}
	service, isService := object.(*corev1.Service)
	if c.raced || !isService || len(service.Spec.Selector) != 0 {
		return nil
	}
	c.raced = true
	var session clusterv1alpha1.T4Session
	if err := c.Client.Get(ctx, c.sessionKey, &session); err != nil {
		return err
	}
	routeReady := meta.FindStatusCondition(session.Status.Conditions, "RouteReady")
	if routeReady == nil || routeReady.Status != metav1.ConditionTrue {
		return errors.New("route revocation conflict fixture requires stale RouteReady=True")
	}
	routeReady.Message = "concurrent status writer preserved stale readiness"
	return c.Client.Status().Update(ctx, &session)
}

func ptr[T any](value T) *T { return &value }
