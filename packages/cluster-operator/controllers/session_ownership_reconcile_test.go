package controllers_test

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	storagev1 "k8s.io/api/storage/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	clusterv1alpha1 "github.com/wolfiesch/omperator/packages/cluster-operator/api/v1alpha1"
	"github.com/wolfiesch/omperator/packages/cluster-operator/controllers"
)

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
			if !contains(waiting.Finalizers, clusterv1alpha1.SessionFinalizer) || condition == nil || condition.Reason != "CleanupOwnershipConflict" {
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
	if condition == nil || condition.Reason != "CleanupOwnershipConflict" || !contains(waiting.Finalizers, clusterv1alpha1.SessionFinalizer) {
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
		{name: "mismatched Host storage class", conditionType: "Available", wantReason: "StorageCapabilitiesUnavailable", revoke: func(ctx context.Context, c client.Client) error {
			otherClass := &storagev1.StorageClass{ObjectMeta: metav1.ObjectMeta{Name: "other-rwx", Annotations: map[string]string{clusterv1alpha1.RWXStorageClassAnnotation: string(corev1.ReadWriteMany)}}, Provisioner: "example.invalid/csi"}
			if err := c.Create(ctx, otherClass); err != nil {
				return err
			}
			var host clusterv1alpha1.T4ClusterHost
			if err := c.Get(ctx, types.NamespacedName{Namespace: "team", Name: "host-a"}, &host); err != nil {
				return err
			}
			host.Spec.StorageClassName = otherClass.Name
			return c.Update(ctx, &host)
		}},
		{name: "classless Workspace PVC", conditionType: "WorkspaceReady", wantReason: "StorageClassMismatch", revoke: func(ctx context.Context, c client.Client) error {
			workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
			workspace.UID = "workspace-uid"
			var pvc corev1.PersistentVolumeClaim
			if err := c.Get(ctx, types.NamespacedName{Namespace: workspace.Namespace, Name: controllers.WorkspacePVCName(workspace)}, &pvc); err != nil {
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
			workspace.UID = "workspace-uid"
			workspace.Status.PVCName = controllers.WorkspacePVCName(workspace)
			pvc := ownedWorkspacePVC(workspace)
			session := testSession()
			session.UID = "session-uid"
			foreignPod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: "foreign-pod", Namespace: "team"}}
			foreignService := &corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: "foreign-service", Namespace: "team"}}
			c := fake.NewClientBuilder().WithScheme(scheme).
				WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).
				WithObjects(testHost(), workspace, pvc, session, foreignPod, foreignService).Build()
			r := configuredSessionReconciler(c, scheme)
			reconcileMany(t, 3, func() error {
				_, err := r.Reconcile(ctx, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
				return err
			})
			bindRuntimeStateVolume(t, c, session)
			markSessionCompositeReady(t, c, session)
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

func TestHostDependencyRecoveryReplacesFalseConditions(t *testing.T) {
	t.Run("Workspace", func(t *testing.T) {
		ctx := context.Background()
		scheme := testScheme(t)
		workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
		workspace.UID = "workspace-uid"
		c := fake.NewClientBuilder().WithScheme(scheme).
			WithStatusSubresource(&clusterv1alpha1.T4Workspace{}, &corev1.PersistentVolumeClaim{}).
			WithIndex(&clusterv1alpha1.T4Session{}, testWorkspaceSessionRefIndexField, testIndexWorkspaceSessionByWorkspaceRef).
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
			"HostReady": metav1.ConditionFalse, "WorkspaceReady": metav1.ConditionUnknown, "RuntimeConfigured": metav1.ConditionUnknown, "Available": metav1.ConditionFalse,
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
			"HostReady": metav1.ConditionTrue, "WorkspaceReady": metav1.ConditionTrue, "RuntimeConfigured": metav1.ConditionTrue, "Available": metav1.ConditionFalse,
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
				if err := c.Get(ctx, client.ObjectKeyFromObject(sibling), sibling); !apierrors.IsNotFound(err) {
					t.Fatalf("exclusively owned sibling remained after ownership conflict: %v", err)
				}
				var failed clusterv1alpha1.T4Session
				if err := c.Get(ctx, client.ObjectKeyFromObject(session), &failed); err != nil {
					t.Fatal(err)
				}
				available := findCondition(failed.Status.Conditions, "Available")
				if available == nil || available.Status != metav1.ConditionFalse || !strings.Contains(available.Reason, "OwnershipConflict") {
					t.Fatalf("foreign owner did not produce stable ownership conflict: %#v", available)
				}
				if path == "normal" {
					assertCurrentSessionConditions(t, &failed, map[string]metav1.ConditionStatus{
						"HostReady": metav1.ConditionTrue, "WorkspaceReady": metav1.ConditionTrue, "RuntimeConfigured": metav1.ConditionTrue, "Available": metav1.ConditionFalse,
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
				assertObjectCounts(t, base, 1, 0)
			} else {
				var got corev1.Service
				if err := base.Get(ctx, client.ObjectKeyFromObject(c.winner), &got); err != nil {
					t.Fatalf("foreign Service winner was deleted: %v", err)
				}
				want := c.winner.(*corev1.Service)
				if !reflect.DeepEqual(got.ObjectMeta, want.ObjectMeta) || !reflect.DeepEqual(got.Spec, want.Spec) {
					t.Fatalf("foreign Service winner was mutated: %#v", got)
				}
				assertObjectCounts(t, base, 0, 1)
			}
			var failed clusterv1alpha1.T4Session
			if err := base.Get(ctx, client.ObjectKeyFromObject(session), &failed); err != nil {
				t.Fatal(err)
			}
			available := findCondition(failed.Status.Conditions, "Available")
			wantReason := kind + "OwnershipConflict"
			if failed.Status.Phase != clusterv1alpha1.InfrastructureFailed ||
				failed.Status.FenceState != clusterv1alpha1.RuntimeFenceProven ||
				available == nil || available.Status != metav1.ConditionFalse || available.Reason != wantReason {
				t.Fatalf("ownership race did not fail closed: status=%#v available=%#v", failed.Status, available)
			}
		})
	}
}
