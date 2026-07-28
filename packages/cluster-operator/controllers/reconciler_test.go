package controllers_test

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	storagev1 "k8s.io/api/storage/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apiresource "k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
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

func TestWorkspaceReconcileIsIdempotentAcrossDuplicateEvents(t *testing.T) {
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
	c := fake.NewClientBuilder().WithScheme(scheme).
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
	if got.Status.ObservedGeneration != got.Generation || got.Status.PVCName != pvc.Name {
		t.Fatalf("workspace status not converged: %#v", got.Status)
	}
	if !contains(got.Finalizers, clusterv1alpha1.WorkspaceFinalizer) {
		t.Fatal("workspace protection finalizer missing")
	}
}

func TestWorkspaceCreateAlreadyExistsRefetchesForeignPVC(t *testing.T) {
	ctx := context.Background()
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
	workspace.UID = "workspace-uid"
	base := fake.NewClientBuilder().WithScheme(scheme).
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
			c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Workspace{}, &corev1.PersistentVolumeClaim{}).WithObjects(testHost(), rwxStorageClass(), workspace, pvc).Build()
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
			c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Workspace{}).WithObjects(objects...).Build()
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
			c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Workspace{}, &corev1.PersistentVolumeClaim{}).WithObjects(test.objects(workspace)...).Build()
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

func staleSessionConditions(generation int64) []metav1.Condition {
	return []metav1.Condition{
		{Type: "HostReady", Status: metav1.ConditionTrue, Reason: "Stale", ObservedGeneration: generation},
		{Type: "WorkspaceReady", Status: metav1.ConditionTrue, Reason: "Stale", ObservedGeneration: generation},
		{Type: "RuntimeConfigured", Status: metav1.ConditionTrue, Reason: "Stale", ObservedGeneration: generation},
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
	} {
		if err := c.Create(context.Background(), object); err != nil && !apierrors.IsAlreadyExists(err) {
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
	for _, add := range []func(*runtime.Scheme) error{corev1.AddToScheme, storagev1.AddToScheme, clusterv1alpha1.AddToScheme} {
		if err := add(scheme); err != nil {
			t.Fatal(err)
		}
	}
	return scheme
}

func testHost() *clusterv1alpha1.T4ClusterHost {
	return &clusterv1alpha1.T4ClusterHost{
		ObjectMeta: metav1.ObjectMeta{Name: "host-a", Namespace: "team", UID: "host-uid"},
		Spec:       clusterv1alpha1.T4ClusterHostSpec{StorageClassName: "portable-rwx", RuntimeProfiles: []string{"default"}},
	}
}

func rwxStorageClass() *storagev1.StorageClass {
	return &storagev1.StorageClass{
		ObjectMeta:  metav1.ObjectMeta{Name: "portable-rwx", Annotations: map[string]string{clusterv1alpha1.RWXStorageClassAnnotation: string(corev1.ReadWriteMany)}},
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
		Spec:       clusterv1alpha1.T4SessionSpec{HostRef: "host-a", WorkspaceRef: "workspace-a", Title: "Session A", RuntimeProfile: "default", GUIEnabled: true},
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

func ptr[T any](value T) *T { return &value }
