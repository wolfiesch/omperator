package controllers_test

import (
	"context"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	storagev1 "k8s.io/api/storage/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	apiresource "k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	utilvalidation "k8s.io/apimachinery/pkg/util/validation"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	clusterv1alpha1 "github.com/wolfiesch/omperator/packages/cluster-operator/api/v1alpha1"
	"github.com/wolfiesch/omperator/packages/cluster-operator/controllers"
)

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
			cmuxName := controllers.SessionCmuxName(session)
			stateID := controllers.RuntimeStateFilesystemRoot(session)
			if len(stateID) > 63 || len(utilvalidation.IsDNS1123Label(stateID)) != 0 ||
				values["T4_SESSION_NAME"] != cmuxName || values["T4_RUNTIME_ID"] != stateID || values["T4_SESSION_STATE_ID"] != stateID {
				t.Fatalf("runtime identity = name %q runtime %q state %q, want cmux %q and safe state ID %q", values["T4_SESSION_NAME"], values["T4_RUNTIME_ID"], values["T4_SESSION_STATE_ID"], cmuxName, stateID)
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
	if len(pod.Spec.Containers) != 3 {
		t.Fatalf("session pod containers = %d, want authority, shell, and credential broker", len(pod.Spec.Containers))
	}
	authority := pod.Spec.Containers[0]
	shell := pod.Spec.Containers[1]
	credential := pod.Spec.Containers[2]
	if authority.Image != r.RuntimeImage || shell.Image != r.RuntimeImage || credential.Image != r.RuntimeImage {
		t.Fatalf("controller did not use administrator-owned runtime image: %#v", pod.Spec.Containers)
	}
	if authority.SecurityContext == nil || authority.SecurityContext.Privileged != nil && *authority.SecurityContext.Privileged {
		t.Fatal("session authority is not restricted")
	}
	if !hasMount(authority.VolumeMounts, "workspace", "/workspace") ||
		!hasMount(authority.VolumeMounts, "runtime-state", "/runtime-state") ||
		!hasMount(authority.VolumeMounts, "credential-broker", "/run/t4-credential") ||
		!hasReadOnlyMount(authority.VolumeMounts, "omp-config-source", "/run/t4-omp-config-source") {
		t.Fatalf("session authority mounts = %#v", authority.VolumeMounts)
	}
	if !hasMount(shell.VolumeMounts, "workspace", "/workspace") ||
		!hasMount(shell.VolumeMounts, "runtime-state", "/runtime-state") ||
		!hasMount(shell.VolumeMounts, "shared-memory", "/dev/shm") {
		t.Fatalf("session shell mounts = %#v", shell.VolumeMounts)
	}
	if !hasMount(credential.VolumeMounts, "credential-broker", "/run/t4-credential") ||
		!hasReadOnlyMount(credential.VolumeMounts, "kubernetes-api-access", "/var/run/secrets/kubernetes.io/serviceaccount") ||
		!hasReadOnlyMount(credential.VolumeMounts, "generation-auth", "/run/t4-generation-auth") {
		t.Fatalf("session credential broker mounts = %#v", credential.VolumeMounts)
	}
	if pod.Spec.ServiceAccountName != controllers.SessionServiceAccountName(session) {
		t.Fatalf("session ServiceAccount = %q", pod.Spec.ServiceAccountName)
	}
	serverIdentity := ""
	configSource := ""
	for containerIndex := range pod.Spec.Containers {
		for envIndex := range pod.Spec.Containers[containerIndex].Env {
			env := &pod.Spec.Containers[containerIndex].Env[envIndex]
			if env.Name == "T4_CLUSTER_SERVER_SERVICE_ACCOUNT" {
				serverIdentity = env.Value
			}
			if env.Name == "T4_OMP_CONFIG_SOURCE_DIR" {
				configSource = env.Value
			}
			if env.ValueFrom != nil && env.ValueFrom.SecretKeyRef != nil {
				t.Fatalf("session container retained a Secret environment reference: %#v", env)
			}
		}
		if len(pod.Spec.Containers[containerIndex].Args) != 0 {
			t.Fatalf("session container received credential arguments: %#v", pod.Spec.Containers[containerIndex].Args)
		}
	}
	if serverIdentity != controllers.DefaultServerServiceAccount {
		t.Fatalf("expected server ServiceAccount = %q", serverIdentity)
	}
	if configSource != "/run/t4-omp-config-source" {
		t.Fatalf("OMP preflight source = %q", configSource)
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
	for _, env := range pod.Spec.Containers[0].Env {
		if len(pod.Spec.Containers[0].Args) != 0 || env.ValueFrom != nil && env.ValueFrom.SecretKeyRef != nil {
			t.Fatalf("OMP mode retained a credential reference: %#v", env)
		}
		if env.Name == "T4_OMP_ALLOW_UNAUTHENTICATED" ||
			strings.Contains(env.Name, "CREDENTIAL") && env.Name != "T4_CREDENTIAL_BROKER_SOCKET" {
			t.Fatalf("OMP mode retained a legacy credential mode sentinel: %#v", env)
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
	reconcileMany(t, 3, func() error {
		_, err := r.Reconcile(context.Background(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(session)})
		return err
	})
	reconcileMany(t, 5, func() error {
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
