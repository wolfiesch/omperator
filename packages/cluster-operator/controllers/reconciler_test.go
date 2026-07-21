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
	apiresource "k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	utilvalidation "k8s.io/apimachinery/pkg/util/validation"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	clusterv1alpha1 "github.com/LycaonLLC/t4-code/packages/cluster-operator/api/v1alpha1"
	"github.com/LycaonLLC/t4-code/packages/cluster-operator/controllers"
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
		Spec: corev1.PersistentVolumeClaimSpec{AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
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
		Spec: corev1.PersistentVolumeClaimSpec{AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
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

func TestSessionFailsClosedWhenAnyOMPReferenceIsMissing(t *testing.T) {
	for _, test := range []struct {
		name   string
		remove func(*controllers.SessionOMPConfig)
		reason string
	}{
		{name: "ConfigMap", remove: func(config *controllers.SessionOMPConfig) { config.ConfigMapName = "" }, reason: "OMPReferencesMissing"},
		{name: "models key", remove: func(config *controllers.SessionOMPConfig) { config.ModelsKey = "" }, reason: "OMPReferencesMissing"},
		{name: "settings key", remove: func(config *controllers.SessionOMPConfig) { config.SettingsKey = "" }, reason: "OMPReferencesMissing"},
		{name: "unsafe credential mode", remove: func(config *controllers.SessionOMPConfig) { config.AllowUnauthenticated = false }, reason: "OMPCredentialProjectionUnsupported"},
	} {
		t.Run(test.name, func(t *testing.T) {
			scheme := testScheme(t)
			workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
			workspace.Status.PVCName = "workspace-a-data"
			pvc := &corev1.PersistentVolumeClaim{
				ObjectMeta: metav1.ObjectMeta{Name: workspace.Status.PVCName, Namespace: "team"},
				Spec:       corev1.PersistentVolumeClaimSpec{AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
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

func TestSessionRejectsInvalidOMPAuthenticationAndProjectionReferences(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*controllers.SessionOMPConfig)
		reason string
	}{
		{name: "legacy credential Secret", mutate: func(config *controllers.SessionOMPConfig) { config.CredentialSecretName = "omp-runtime-credential" }, reason: "OMPCredentialProjectionUnsupported"},
		{name: "legacy credential key", mutate: func(config *controllers.SessionOMPConfig) { config.CredentialKey = "MODEL_API_KEY" }, reason: "OMPCredentialProjectionUnsupported"},
		{name: "credential mode", mutate: func(config *controllers.SessionOMPConfig) { config.AllowUnauthenticated = false }, reason: "OMPCredentialProjectionUnsupported"},
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

func TestSessionCredentialModeUpgradeStopsExistingAuthorityAndClearsRoute(t *testing.T) {
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
	workspace.Status.PVCName = "workspace-a-data"
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: workspace.Status.PVCName, Namespace: "team"},
		Spec:       corev1.PersistentVolumeClaimSpec{AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
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
	var running clusterv1alpha1.T4Session
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(session), &running); err != nil {
		t.Fatal(err)
	}
	if running.Status.PodName == "" || running.Status.ServiceName == "" {
		t.Fatalf("session did not publish its initial route: %#v", running.Status)
	}

	r.OMPConfig.AllowUnauthenticated = false
	r.OMPConfig.CredentialSecretName = "omp-runtime-credential"
	r.OMPConfig.CredentialKey = "MODEL_API_KEY"
	if _, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
		t.Fatal(err)
	}
	assertObjectCounts(t, c, 0, 0)
	var failed clusterv1alpha1.T4Session
	if err := c.Get(context.Background(), client.ObjectKeyFromObject(session), &failed); err != nil {
		t.Fatal(err)
	}
	condition := findCondition(failed.Status.Conditions, "RuntimeConfigured")
	if failed.Status.PodName != "" || failed.Status.ServiceName != "" || failed.Status.Phase != clusterv1alpha1.InfrastructureFailed || condition == nil || condition.Reason != "OMPCredentialProjectionUnsupported" {
		t.Fatalf("unsafe upgrade retained authority route: status=%#v condition=%#v", failed.Status, condition)
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
				Spec:       corev1.PersistentVolumeClaimSpec{AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
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
				Spec:       corev1.PersistentVolumeClaimSpec{AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
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
				Spec:       corev1.PersistentVolumeClaimSpec{AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
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
				Spec:       corev1.PersistentVolumeClaimSpec{AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
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
				Spec:       corev1.PersistentVolumeClaimSpec{AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
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
			stateID := strings.TrimPrefix(pod.Name, "t4-session-")
			if len(stateID) > 63 || len(utilvalidation.IsDNS1123Label(stateID)) != 0 || values["T4_SESSION_NAME"] != stateID || values["T4_SESSION_STATE_ID"] != stateID {
				t.Fatalf("runtime identity = name %q state %q, want safe state ID %q", values["T4_SESSION_NAME"], values["T4_SESSION_STATE_ID"], stateID)
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
		Spec:       corev1.PersistentVolumeClaimSpec{AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
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
	if pod.Spec.Containers[0].Image != r.RuntimeImage {
		t.Fatalf("controller did not use administrator-owned runtime image: %q", pod.Spec.Containers[0].Image)
	}
	if pod.Spec.Containers[0].SecurityContext == nil || pod.Spec.Containers[0].SecurityContext.Privileged != nil && *pod.Spec.Containers[0].SecurityContext.Privileged {
		t.Fatal("session runtime is not restricted")
	}
	if !hasMount(pod.Spec.Containers[0].VolumeMounts, "workspace", "/workspace") ||
		!hasMount(pod.Spec.Containers[0].VolumeMounts, "shared-memory", "/dev/shm") ||
		!hasReadOnlyMount(pod.Spec.Containers[0].VolumeMounts, "omp-config-source", "/run/t4-omp-config-source") {
		t.Fatalf("session mounts = %#v", pod.Spec.Containers[0].VolumeMounts)
	}
	if pod.Spec.ServiceAccountName != controllers.DefaultSessionServiceAccount {
		t.Fatalf("session ServiceAccount = %q", pod.Spec.ServiceAccountName)
	}
	serverIdentity := ""
	configSource := ""
	allowUnauthenticated := ""
	for i := range pod.Spec.Containers[0].Env {
		env := &pod.Spec.Containers[0].Env[i]
		if env.Name == "T4_CLUSTER_SERVER_SERVICE_ACCOUNT" {
			serverIdentity = env.Value
		}
		if env.Name == "T4_OMP_CONFIG_SOURCE_DIR" {
			configSource = env.Value
		}
		if env.Name == "T4_OMP_ALLOW_UNAUTHENTICATED" {
			allowUnauthenticated = env.Value
		}
		if env.ValueFrom != nil && env.ValueFrom.SecretKeyRef != nil {
			t.Fatalf("session runtime retained a Secret environment reference: %#v", env)
		}
	}
	if serverIdentity != controllers.DefaultServerServiceAccount {
		t.Fatalf("expected server ServiceAccount = %q", serverIdentity)
	}
	if configSource != "/run/t4-omp-config-source" || allowUnauthenticated != "true" {
		t.Fatalf("OMP preflight environment = source %q allowUnauthenticated %q", configSource, allowUnauthenticated)
	}
	if len(pod.Spec.Containers[0].Args) != 0 {
		t.Fatalf("session runtime received credential arguments: %#v", pod.Spec.Containers[0].Args)
	}
	apiAudience := ""
	for _, env := range pod.Spec.Containers[0].Env {
		if env.Name == "T4_KUBERNETES_API_AUDIENCE" {
			apiAudience = env.Value
		}
	}
	if apiAudience != r.KubernetesAPIAudience {
		t.Fatalf("reviewer API audience environment = %q", apiAudience)
	}
	if !hasMount(pod.Spec.Containers[0].VolumeMounts, "kubernetes-api-access", "/var/run/secrets/kubernetes.io/serviceaccount") {
		t.Fatal("explicit Kubernetes reviewer projection is not mounted")
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

func TestSessionOMPModeOmitsCredentialSecretReference(t *testing.T) {
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
	workspace.Status.PVCName = "workspace-a-data"
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: workspace.Status.PVCName, Namespace: "team"},
		Spec:       corev1.PersistentVolumeClaimSpec{AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
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
	allowUnauthenticated := ""
	for _, env := range pod.Spec.Containers[0].Env {
		if env.Name == "T4_OMP_ALLOW_UNAUTHENTICATED" {
			allowUnauthenticated = env.Value
		}
		if len(pod.Spec.Containers[0].Args) != 0 || env.ValueFrom != nil && env.ValueFrom.SecretKeyRef != nil {
			t.Fatalf("unauthenticated OMP mode retained a credential reference: %#v", env)
		}
	}
	if allowUnauthenticated != "true" {
		t.Fatalf("T4_OMP_ALLOW_UNAUTHENTICATED = %q, want true", allowUnauthenticated)
	}
}

func TestSessionRejectsUnownedDeterministicResources(t *testing.T) {
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
	workspace.Status.PVCName = "workspace-a-data"
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: workspace.Status.PVCName, Namespace: "team"},
		Spec:       corev1.PersistentVolumeClaimSpec{AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
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
	if condition == nil || condition.Reason != "ServiceOwnershipConflict" || got.Status.Phase != clusterv1alpha1.InfrastructureFailed {
		t.Fatalf("collision status = %#v/%q", condition, got.Status.Phase)
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
		Spec:       corev1.PersistentVolumeClaimSpec{AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
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
				Spec:       corev1.PersistentVolumeClaimSpec{AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
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
				Spec:       corev1.PersistentVolumeClaimSpec{AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
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
				Spec:       corev1.PersistentVolumeClaimSpec{AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
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
			pvc := &corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{Name: workspace.Status.PVCName, Namespace: "team"}, Spec: corev1.PersistentVolumeClaimSpec{AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}}, Status: corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound}}
			session := testSession()
			objects := []client.Object{testHost(), rwxStorageClass(), workspace, pvc, session}
			if test.configMap != nil {
				objects = append(objects, test.configMap)
			}
			c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Session{}, &corev1.PersistentVolumeClaim{}, &corev1.Pod{}).WithObjects(objects...).Build()
			r := &controllers.SessionReconciler{Client: c, APIReader: c, Scheme: scheme, RuntimeImage: testRuntimeImage, OMPConfig: controllers.SessionOMPConfig{ConfigMapName: "omp-runtime-config", ModelsKey: "provider-models", SettingsKey: "agent-settings", AllowUnauthenticated: true}}
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
		Spec:       corev1.PersistentVolumeClaimSpec{AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
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
		Spec:       corev1.PersistentVolumeClaimSpec{AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
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
		for _, mismatch := range []string{"uid-annotation", "controller-owner"} {
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
				} else {
					pvc.OwnerReferences = []metav1.OwnerReference{{
						APIVersion: clusterv1alpha1.GroupVersion.String(), Kind: "T4Workspace", Name: "foreign", UID: "foreign-workspace-uid", Controller: ptr(true),
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
			if err := c.Delete(context.Background(), session); err != nil {
				t.Fatal(err)
			}
			r := &controllers.SessionReconciler{Client: c, Scheme: scheme}
			if _, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)}); err != nil {
				t.Fatal(err)
			}
			assertObjectCounts(t, c, 1, 1)
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
		{name: "invalid OMP credential Secret", conditionType: "RuntimeConfigured", wantReason: "OMPCredentialSecretInvalid", revoke: func(ctx context.Context, c client.Client) error {
			var secret corev1.Secret
			if err := c.Get(ctx, types.NamespacedName{Namespace: "team", Name: "omp-runtime-credential"}, &secret); err != nil {
				return err
			}
			delete(secret.Data, "MODEL_API_KEY")
			return c.Update(ctx, &secret)
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
			return c.Update(ctx, &host)
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
	oldClass := "portable-rwx"
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name: workspace.Status.PVCName, Namespace: workspace.Namespace,
			Annotations:     map[string]string{clusterv1alpha1.WorkspaceUIDAnnotation: string(workspace.UID)},
			OwnerReferences: []metav1.OwnerReference{{APIVersion: clusterv1alpha1.GroupVersion.String(), Kind: "T4Workspace", Name: workspace.Name, UID: workspace.UID, Controller: ptr(true)}},
		},
		Spec: corev1.PersistentVolumeClaimSpec{StorageClassName: &oldClass, AccessModes: []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany}},
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
	if retained.Spec.StorageClassName == nil || *retained.Spec.StorageClassName != oldClass {
		t.Fatalf("storage drift recreated or mutated PVC class: %#v", retained.Spec.StorageClassName)
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
			ConfigMapName:        "omp-runtime-config",
			ModelsKey:            "provider-models",
			SettingsKey:          "agent-settings",
			AllowUnauthenticated: true,
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

func ptr[T any](value T) *T { return &value }
