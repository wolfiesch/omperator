package controllers_test

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	clusterv1alpha1 "github.com/wolfiesch/omperator/packages/cluster-operator/api/v1alpha1"
	"github.com/wolfiesch/omperator/packages/cluster-operator/controllers"
)

func sessionConfigurationFixture(
	t *testing.T,
) (*clusterv1alpha1.T4Session, client.Client, *controllers.SessionReconciler) {
	t.Helper()
	scheme := testScheme(t)
	workspace := testWorkspace(clusterv1alpha1.RetentionPolicyDelete)
	workspace.Status.PVCName = "workspace-a-data"
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:      workspace.Status.PVCName,
			Namespace: "team",
		},
		Spec: corev1.PersistentVolumeClaimSpec{
			StorageClassName: ptr("portable-rwx"),
			AccessModes:      []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany},
		},
		Status: corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound},
	}
	session := testSession()
	clusterClient := fake.NewClientBuilder().
		WithScheme(scheme).
		WithStatusSubresource(
			&clusterv1alpha1.T4Session{},
			&corev1.PersistentVolumeClaim{},
			&corev1.Pod{},
		).
		WithObjects(testHost(), workspace, pvc, session).
		Build()
	return session, clusterClient, configuredSessionReconciler(clusterClient, scheme)
}

func reconcileSessionConfiguration(
	t *testing.T,
	clusterClient client.Client,
	reconciler *controllers.SessionReconciler,
	session *clusterv1alpha1.T4Session,
) clusterv1alpha1.T4Session {
	t.Helper()
	if _, err := reconciler.Reconcile(
		context.Background(),
		ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)},
	); err != nil {
		t.Fatal(err)
	}
	var got clusterv1alpha1.T4Session
	if err := clusterClient.Get(
		context.Background(),
		client.ObjectKeyFromObject(session),
		&got,
	); err != nil {
		t.Fatal(err)
	}
	return got
}

func assertRuntimeConfiguredReason(
	t *testing.T,
	session clusterv1alpha1.T4Session,
	reason string,
) {
	t.Helper()
	condition := findCondition(session.Status.Conditions, "RuntimeConfigured")
	if condition == nil ||
		condition.Status != metav1.ConditionFalse ||
		condition.Reason != reason {
		t.Fatalf("RuntimeConfigured = %#v, want False/%s", condition, reason)
	}
}

func TestSessionFailsClosedWhenAnyOMPReferenceIsMissing(t *testing.T) {
	for _, test := range []struct {
		name   string
		remove func(*controllers.SessionOMPConfig)
	}{
		{
			name: "ConfigMap",
			remove: func(config *controllers.SessionOMPConfig) {
				config.ConfigMapName = ""
			},
		},
		{
			name: "models key",
			remove: func(config *controllers.SessionOMPConfig) {
				config.ModelsKey = ""
			},
		},
		{
			name: "settings key",
			remove: func(config *controllers.SessionOMPConfig) {
				config.SettingsKey = ""
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			session, clusterClient, reconciler := sessionConfigurationFixture(t)
			test.remove(&reconciler.OMPConfig)
			got := reconcileSessionConfiguration(t, clusterClient, reconciler, session)
			assertObjectCounts(t, clusterClient, 0, 0)
			assertRuntimeConfiguredReason(t, got, "OMPReferencesMissing")
		})
	}
}

func TestSessionRejectsInvalidOMPProjectionReferences(t *testing.T) {
	session, clusterClient, reconciler := sessionConfigurationFixture(t)
	reconciler.OMPConfig.SettingsKey = reconciler.OMPConfig.ModelsKey
	got := reconcileSessionConfiguration(t, clusterClient, reconciler, session)
	assertObjectCounts(t, clusterClient, 0, 0)
	assertRuntimeConfiguredReason(t, got, "OMPReferencesInvalid")
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
			session, clusterClient, reconciler := sessionConfigurationFixture(t)
			var configMap corev1.ConfigMap
			key := types.NamespacedName{
				Namespace: "team",
				Name:      reconciler.OMPConfig.ConfigMapName,
			}
			if err := clusterClient.Get(context.Background(), key, &configMap); err != nil {
				t.Fatal(err)
			}
			configMap.Data[reconciler.OMPConfig.ModelsKey] = test.models
			if err := clusterClient.Update(context.Background(), &configMap); err != nil {
				t.Fatal(err)
			}
			var got clusterv1alpha1.T4Session
			reconcileMany(t, 2, func() error {
				var err error
				got = reconcileSessionConfiguration(t, clusterClient, reconciler, session)
				return err
			})
			assertRuntimeConfiguredReason(t, got, "OMPModelsAuthenticationUnsafe")
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
			session, clusterClient, reconciler := sessionConfigurationFixture(t)
			var configMap corev1.ConfigMap
			key := types.NamespacedName{
				Namespace: "team",
				Name:      reconciler.OMPConfig.ConfigMapName,
			}
			if err := clusterClient.Get(context.Background(), key, &configMap); err != nil {
				t.Fatal(err)
			}
			configMap.Data[reconciler.OMPConfig.SettingsKey] = test.settings
			if err := clusterClient.Update(context.Background(), &configMap); err != nil {
				t.Fatal(err)
			}
			var got clusterv1alpha1.T4Session
			reconcileMany(t, 2, func() error {
				got = reconcileSessionConfiguration(t, clusterClient, reconciler, session)
				return nil
			})
			assertRuntimeConfiguredReason(t, got, "OMPSettingsAuthenticationUnsafe")
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
			session, clusterClient, reconciler := sessionConfigurationFixture(t)
			reconciler.RuntimeImage = test.image
			got := reconcileSessionConfiguration(t, clusterClient, reconciler, session)
			if test.wantReason == "" {
				assertObjectCounts(t, clusterClient, 1, 1)
				var pod corev1.Pod
				if err := clusterClient.Get(
					context.Background(),
					types.NamespacedName{
						Namespace: session.Namespace,
						Name:      controllers.SessionPodName(session),
					},
					&pod,
				); err != nil {
					t.Fatal(err)
				}
				if pod.Spec.Containers[0].Image != test.image {
					t.Fatalf("runtime image = %q, want %q", pod.Spec.Containers[0].Image, test.image)
				}
				return
			}
			assertObjectCounts(t, clusterClient, 0, 0)
			assertRuntimeConfiguredReason(t, got, test.wantReason)
		})
	}
}
