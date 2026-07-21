package controllers

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"reflect"
	"regexp"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	storagev1 "k8s.io/api/storage/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	meta "k8s.io/apimachinery/pkg/api/meta"
	apiresource "k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	intstr "k8s.io/apimachinery/pkg/util/intstr"
	utilvalidation "k8s.io/apimachinery/pkg/util/validation"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	clusterv1alpha1 "github.com/LycaonLLC/t4-code/packages/cluster-operator/api/v1alpha1"
)

const (
	DefaultSessionServiceAccount                = "t4-cluster-session"
	DefaultServerServiceAccount                 = "t4-cluster-server"
	DefaultKubernetesAPIAudience                = "https://kubernetes.default.svc"
	SessionReviewerTokenExpirationSeconds int64 = 3600
)

var (
	configMapKeyPattern = regexp.MustCompile(`^[-._A-Za-z0-9]+$`)
	envVarNamePattern   = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	runtimeImagePattern = regexp.MustCompile(`^(?:(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[A-Fa-f0-9:]+\])(?::[0-9]+)?/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*@sha256:[a-f0-9]{64}$`)
)

func reservedCredentialEnvironment(name string) bool {
	if strings.HasPrefix(name, "T4_") || strings.HasPrefix(name, "OMP_") || strings.HasPrefix(name, "PI_") || strings.HasPrefix(name, "XDG_") || strings.HasPrefix(name, "LD_") {
		return true
	}
	switch name {
	case "HOME", "DISPLAY", "PATH", "BASH_ENV", "ENV", "SHELLOPTS", "NODE_OPTIONS", "BUN_OPTIONS":
		return true
	default:
		return false
	}
}

type SessionOMPConfig struct {
	ConfigMapName        string
	ModelsKey            string
	SettingsKey          string
	CredentialSecretName string
	CredentialKey        string
	AllowUnauthenticated bool
}
type ompResourceVersions struct {
	ConfigMap        string `json:"configMap"`
	CredentialSecret string `json:"credentialSecret,omitempty"`
}

func (r *SessionReconciler) loadOMPResourceVersions(ctx context.Context, namespace string) (ompResourceVersions, string, string, error) {
	reader := r.APIReader
	if reader == nil {
		reader = r.Client
	}
	var configMap corev1.ConfigMap
	if err := reader.Get(ctx, types.NamespacedName{Namespace: namespace, Name: r.OMPConfig.ConfigMapName}, &configMap); err != nil {
		if apierrors.IsNotFound(err) {
			return ompResourceVersions{}, "OMPConfigMapNotFound", "administrator-owned OMP ConfigMap does not exist", nil
		}
		return ompResourceVersions{}, "", "", err
	}
	if configMap.Data[r.OMPConfig.ModelsKey] == "" || configMap.Data[r.OMPConfig.SettingsKey] == "" {
		return ompResourceVersions{}, "OMPConfigMapInvalid", "administrator-owned OMP ConfigMap must contain nonempty models and settings keys", nil
	}
	versions := ompResourceVersions{ConfigMap: configMap.ResourceVersion}
	if r.OMPConfig.AllowUnauthenticated {
		return versions, "", "", nil
	}
	var secret corev1.Secret
	if err := reader.Get(ctx, types.NamespacedName{Namespace: namespace, Name: r.OMPConfig.CredentialSecretName}, &secret); err != nil {
		if apierrors.IsNotFound(err) {
			return ompResourceVersions{}, "OMPCredentialSecretNotFound", "administrator-owned OMP credential Secret does not exist", nil
		}
		return ompResourceVersions{}, "", "", err
	}
	if len(secret.Data[r.OMPConfig.CredentialKey]) == 0 {
		return ompResourceVersions{}, "OMPCredentialSecretInvalid", "administrator-owned OMP credential Secret must contain the configured nonempty key", nil
	}
	versions.CredentialSecret = secret.ResourceVersion
	return versions, "", "", nil
}

func (config SessionOMPConfig) validationFailure() (string, string) {
	if config.ConfigMapName == "" || config.ModelsKey == "" || config.SettingsKey == "" {
		return "OMPReferencesMissing", "administrator-owned OMP ConfigMap and configuration keys are not configured"
	}
	if config.AllowUnauthenticated {
		if config.CredentialSecretName != "" || config.CredentialKey != "" {
			return "OMPReferencesInvalid", "unauthenticated OMP mode cannot include credential Secret references"
		}
	} else {
		if config.CredentialSecretName == "" && config.CredentialKey == "" {
			return "OMPReferencesMissing", "administrator-owned OMP credential Secret and key are not configured"
		}
		if config.CredentialSecretName == "" || config.CredentialKey == "" {
			return "OMPReferencesInvalid", "OMP credential Secret and key must be configured together"
		}
	}
	if len(utilvalidation.IsDNS1123Subdomain(config.ConfigMapName)) != 0 ||
		len(config.ModelsKey) > 253 || !configMapKeyPattern.MatchString(config.ModelsKey) ||
		len(config.SettingsKey) > 253 || !configMapKeyPattern.MatchString(config.SettingsKey) ||
		config.ModelsKey == config.SettingsKey ||
		(config.CredentialSecretName != "" && len(utilvalidation.IsDNS1123Subdomain(config.CredentialSecretName)) != 0) ||
		(config.CredentialKey != "" && (len(config.CredentialKey) > 253 || !envVarNamePattern.MatchString(config.CredentialKey) || reservedCredentialEnvironment(config.CredentialKey))) {
		return "OMPReferencesInvalid", "administrator-owned OMP configuration references are invalid"
	}
	return "", ""
}

func runtimeImageValidationFailure(image string) (string, string) {
	if image == "" {
		return "RuntimeImageMissing", "administrator-owned session runtime image is not configured"
	}
	digestSeparator := strings.Index(image, "@sha256:")
	if digestSeparator <= 0 || digestSeparator > 255 || !runtimeImagePattern.MatchString(image) {
		return "RuntimeImageInvalid", "administrator-owned session runtime image must be an exact repository@sha256 digest with 64 lowercase hexadecimal characters"
	}
	return "", ""
}

type SessionReconciler struct {
	client.Client
	Scheme                    *runtime.Scheme
	APIReader                 client.Reader
	RuntimeImage              string
	SessionServiceAccountName string
	ServerServiceAccountName  string
	KubernetesAPIAudience     string
	OMPConfig                 SessionOMPConfig
	ExcludedNodeNames         []string
	Resources                 corev1.ResourceRequirements
	SharedMemorySize          apiresource.Quantity
	TemporarySize             apiresource.Quantity
}

func (r *SessionReconciler) Reconcile(ctx context.Context, request ctrl.Request) (result ctrl.Result, err error) {
	var session clusterv1alpha1.T4Session
	found := false
	defer func() {
		observeReconcile(metricKindSession, request.NamespacedName, session.Status.Conditions, conditionObjectPresent(&session, found, err), err)
	}()
	if err := r.Get(ctx, request.NamespacedName, &session); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	found = true
	if !session.DeletionTimestamp.IsZero() {
		return r.reconcileDelete(ctx, &session)
	}
	if controllerutil.AddFinalizer(&session, clusterv1alpha1.SessionFinalizer) {
		if err := r.Update(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
	}
	if reason, message := runtimeImageValidationFailure(r.RuntimeImage); reason != "" {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, "RuntimeConfigured", reason, message)
	}
	if reason, message := r.OMPConfig.validationFailure(); reason != "" {
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, "RuntimeConfigured", reason, message)
	}

	var host clusterv1alpha1.T4ClusterHost
	if err := r.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: session.Spec.HostRef}, &host); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, "HostReady", "HostNotFound", "referenced T4ClusterHost does not exist")
		}
		return ctrl.Result{}, err
	}
	if !hasString(host.Spec.RuntimeProfiles, session.Spec.RuntimeProfile) {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, "RuntimeConfigured", "RuntimeProfileNotAllowed", "runtime profile is not allowed by the referenced T4ClusterHost")
	}
	var storageClass storagev1.StorageClass
	if err := r.Get(ctx, types.NamespacedName{Name: host.Spec.StorageClassName}, &storageClass); err != nil {
		if apierrors.IsNotFound(err) {
			if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
				return ctrl.Result{}, err
			}
			return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, "WorkspaceReady", ReasonStorageClassNotFound, fmt.Sprintf("StorageClass %q selected by the referenced T4ClusterHost does not exist", host.Spec.StorageClassName))
		}
		return ctrl.Result{}, err
	}
	if !storageClassAllowsRWX(storageClass.Annotations) {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, "WorkspaceReady", ReasonStorageClassNotRWX, fmt.Sprintf("StorageClass %q selected by the referenced T4ClusterHost is not administrator-declared ReadWriteMany", host.Spec.StorageClassName))
	}
	var workspace clusterv1alpha1.T4Workspace
	if err := r.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: session.Spec.WorkspaceRef}, &workspace); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, "WorkspaceReady", "WorkspaceNotFound", "referenced T4Workspace does not exist")
		}
		return ctrl.Result{}, err
	}
	if workspace.Spec.HostRef != session.Spec.HostRef {
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, "WorkspaceReady", "HostMismatch", "session and workspace must reference the same T4ClusterHost")
	}
	if workspace.Status.PVCName == "" {
		return ctrl.Result{RequeueAfter: 5 * time.Second}, r.updateSessionFailure(ctx, &session, "WorkspaceReady", "PVCNotDeclared", "workspace controller has not declared a PVC")
	}
	var pvc corev1.PersistentVolumeClaim
	if err := r.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: workspace.Status.PVCName}, &pvc); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{RequeueAfter: 5 * time.Second}, r.updateSessionFailure(ctx, &session, "WorkspaceReady", "PVCNotFound", "workspace PVC does not exist")
		}
		return ctrl.Result{}, err
	}
	if pvc.Status.Phase != corev1.ClaimBound || !pvcHasRWX(&pvc) {
		return ctrl.Result{RequeueAfter: 5 * time.Second}, r.updateSessionFailure(ctx, &session, "WorkspaceReady", "PVCNotBoundRWX", "workspace PVC must be Bound and ReadWriteMany before a session starts")
	}
	runtimeVersions, reason, message, err := r.loadOMPResourceVersions(ctx, session.Namespace)
	if err != nil {
		return ctrl.Result{}, err
	}
	if reason != "" {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, "RuntimeConfigured", reason, message)
	}

	serviceName := SessionServiceName(&session)
	podName := SessionPodName(&session)
	labels := map[string]string{
		"app.kubernetes.io/name":    "t4-session-runtime",
		"app.kubernetes.io/part-of": "t4-cluster",
		"cluster.t4.dev/session":    podName,
	}
	desiredService := corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: serviceName, Namespace: session.Namespace, Labels: labels},
		Spec: corev1.ServiceSpec{
			Type:     corev1.ServiceTypeClusterIP,
			Selector: labels,
			Ports:    []corev1.ServicePort{{Name: "host", Port: 8787, TargetPort: intstr.FromString("host"), Protocol: corev1.ProtocolTCP}},
		},
	}
	if err := controllerutil.SetControllerReference(&session, &desiredService, r.Scheme); err != nil {
		return ctrl.Result{}, err
	}
	var service corev1.Service
	if err := r.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: serviceName}, &service); apierrors.IsNotFound(err) {
		service = desiredService
		if err := r.Create(ctx, &service); err != nil && !apierrors.IsAlreadyExists(err) {
			return ctrl.Result{}, err
		}
	} else if err != nil {
		return ctrl.Result{}, err
	} else if !metav1.IsControlledBy(&service, &session) {
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, "Available", "ServiceOwnershipConflict", "deterministic session Service is not controlled by this session")
	} else if !serviceExposureIsInternal(&service) {
		if err := r.Delete(ctx, &service); err != nil && !apierrors.IsNotFound(err) {
			return ctrl.Result{}, err
		}
		if err := r.updateSessionPending(ctx, &session, podName, serviceName, "ServiceExposureChanged", "session Service is being recreated with ClusterIP-only exposure"); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: time.Second}, nil
	} else if !reflect.DeepEqual(service.Spec.Selector, desiredService.Spec.Selector) || !reflect.DeepEqual(service.Spec.Ports, desiredService.Spec.Ports) || !reflect.DeepEqual(service.Labels, desiredService.Labels) {
		service.Spec.Selector = desiredService.Spec.Selector
		service.Spec.Ports = desiredService.Spec.Ports
		service.Labels = desiredService.Labels
		if err := r.Update(ctx, &service); err != nil {
			return ctrl.Result{}, err
		}
	}

	desiredPod, err := r.desiredPod(&session, workspace.Status.PVCName, podName, labels, runtimeVersions)
	if err != nil {
		return ctrl.Result{}, err
	}
	if err := controllerutil.SetControllerReference(&session, &desiredPod, r.Scheme); err != nil {
		return ctrl.Result{}, err
	}
	var pod corev1.Pod
	if err := r.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: podName}, &pod); apierrors.IsNotFound(err) {
		pod = desiredPod
		if err := r.Create(ctx, &pod); err != nil && !apierrors.IsAlreadyExists(err) {
			return ctrl.Result{}, err
		}
	} else if err != nil {
		return ctrl.Result{}, err
	} else if !metav1.IsControlledBy(&pod, &session) {
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, "Available", "PodOwnershipConflict", "deterministic session Pod is not controlled by this session")
	} else if !labelsContain(pod.Labels, desiredPod.Labels) {
		if pod.Labels == nil {
			pod.Labels = map[string]string{}
		}
		for key, value := range desiredPod.Labels {
			pod.Labels[key] = value
		}
		if err := r.Update(ctx, &pod); err != nil {
			return ctrl.Result{}, err
		}
		if err := r.updateSessionPending(ctx, &session, podName, serviceName, "PodLabelsChanged", "session Pod selector labels are being restored"); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: time.Second}, nil
	} else if pod.Annotations[clusterv1alpha1.SessionPodSpecHashAnnotation] != desiredPod.Annotations[clusterv1alpha1.SessionPodSpecHashAnnotation] {
		if err := r.Delete(ctx, &pod); err != nil && !apierrors.IsNotFound(err) {
			return ctrl.Result{}, err
		}
		if err := r.updateSessionPending(ctx, &session, podName, serviceName, "PodSpecChanged", "session Pod is being recreated to apply immutable desired state"); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: time.Second}, nil
	}

	original := session.Status
	if session.Status.Conditions != nil {
		original.Conditions = append([]metav1.Condition(nil), session.Status.Conditions...)
	}
	session.Status.ObservedGeneration = session.Generation
	session.Status.PodName = podName
	session.Status.ServiceName = serviceName
	meta.SetStatusCondition(&session.Status.Conditions, condition("WorkspaceReady", metav1.ConditionTrue, "PVCBoundRWX", "workspace PVC is Bound and ReadWriteMany", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("RuntimeConfigured", metav1.ConditionTrue, "OMPReferencesReady", "administrator-owned OMP runtime references are configured", session.Generation))
	if podReady(&pod) {
		session.Status.Phase = clusterv1alpha1.InfrastructureRunning
		meta.SetStatusCondition(&session.Status.Conditions, condition("Available", metav1.ConditionTrue, "PodReady", "session infrastructure pod is ready", session.Generation))
	} else if pod.Status.Phase == corev1.PodFailed {
		session.Status.Phase = clusterv1alpha1.InfrastructureFailed
		meta.SetStatusCondition(&session.Status.Conditions, condition("Available", metav1.ConditionFalse, "PodFailed", "session infrastructure pod failed", session.Generation))
	} else {
		session.Status.Phase = clusterv1alpha1.InfrastructurePending
		meta.SetStatusCondition(&session.Status.Conditions, condition("Available", metav1.ConditionFalse, "PodStarting", "session infrastructure pod is starting", session.Generation))
	}
	if !reflect.DeepEqual(original, session.Status) {
		if err := r.Status().Update(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
	}
	if !podReady(&pod) {
		return ctrl.Result{RequeueAfter: 5 * time.Second}, nil
	}
	return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
}

func (r *SessionReconciler) desiredPod(session *clusterv1alpha1.T4Session, pvcName, podName string, labels map[string]string, runtimeVersions ompResourceVersions) (corev1.Pod, error) {
	falseValue := false
	trueValue := true
	runAsUser := int64(10001)
	fsGroup := int64(10001)
	grace := int64(45)
	shmSize := r.SharedMemorySize.DeepCopy()
	if shmSize.IsZero() {
		shmSize = apiresource.MustParse("1Gi")
	}
	temporarySize := r.TemporarySize.DeepCopy()
	if temporarySize.IsZero() {
		temporarySize = apiresource.MustParse("2Gi")
	}
	resources := r.Resources.DeepCopy()
	if resources.Requests == nil {
		resources.Requests = corev1.ResourceList{corev1.ResourceCPU: apiresource.MustParse("500m"), corev1.ResourceMemory: apiresource.MustParse("1Gi")}
	}
	if resources.Limits == nil {
		resources.Limits = corev1.ResourceList{corev1.ResourceCPU: apiresource.MustParse("4"), corev1.ResourceMemory: apiresource.MustParse("8Gi")}
	}
	sessionServiceAccount := r.SessionServiceAccountName
	if sessionServiceAccount == "" {
		sessionServiceAccount = DefaultSessionServiceAccount
	}
	serverServiceAccount := r.ServerServiceAccountName
	if serverServiceAccount == "" {
		serverServiceAccount = DefaultServerServiceAccount
	}
	kubernetesAPIAudience := r.KubernetesAPIAudience
	if kubernetesAPIAudience == "" {
		kubernetesAPIAudience = DefaultKubernetesAPIAudience
	}
	excluded := r.ExcludedNodeNames
	if len(excluded) == 0 {
		excluded = []string{"k3s-worker-02"}
	}
	stateID := strings.TrimPrefix(podName, "t4-session-")
	container := corev1.Container{
		Name: "session-runtime", Image: r.RuntimeImage, ImagePullPolicy: corev1.PullIfNotPresent,
		Ports: []corev1.ContainerPort{{Name: "host", ContainerPort: 8787, Protocol: corev1.ProtocolTCP}},
		Env: []corev1.EnvVar{
			{Name: "T4_CLUSTER_SERVER_SERVICE_ACCOUNT", Value: serverServiceAccount},
			{Name: "T4_KUBERNETES_TOKEN_PATH", Value: "/var/run/secrets/kubernetes.io/serviceaccount/token"},
			{Name: "T4_KUBERNETES_CA_PATH", Value: "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"},
			{Name: "T4_KUBERNETES_NAMESPACE_PATH", Value: "/var/run/secrets/kubernetes.io/serviceaccount/namespace"},
			{Name: "T4_KUBERNETES_API_AUDIENCE", Value: kubernetesAPIAudience},
			{Name: "T4_SESSION_NAME", Value: stateID},
			{Name: "T4_SESSION_STATE_ID", Value: stateID},
			{Name: "T4_WORKSPACE_ROOT", Value: "/workspace"},
			{Name: "T4_SESSION_STATE_ROOT", Value: "/workspace/.t4/sessions/" + stateID},
			{Name: "T4_AUTHORITY_STATE_DIR", Value: "/workspace/.t4/sessions/" + stateID + "/authority"},
			{Name: "T4_BROWSER_STATE_DIR", Value: "/workspace/.t4/sessions/" + stateID + "/browser"},
			{Name: "T4_GUI_ENABLED", Value: fmt.Sprintf("%t", session.Spec.GUIEnabled)},
			{Name: "DISPLAY", Value: ":99"},
			{Name: "T4_OMP_CONFIG_SOURCE_DIR", Value: "/run/t4-omp-config-source"},
			{Name: "T4_OMP_ALLOW_UNAUTHENTICATED", Value: fmt.Sprintf("%t", r.OMPConfig.AllowUnauthenticated)},
		},
		VolumeMounts: []corev1.VolumeMount{
			{Name: "workspace", MountPath: "/workspace"},
			{Name: "runtime", MountPath: "/run"},
			{Name: "temporary", MountPath: "/tmp"},
			{Name: "shared-memory", MountPath: "/dev/shm"},
			{Name: "kubernetes-api-access", MountPath: "/var/run/secrets/kubernetes.io/serviceaccount", ReadOnly: true},
			{Name: "omp-config-source", MountPath: "/run/t4-omp-config-source", ReadOnly: true},
		},
		SecurityContext: &corev1.SecurityContext{
			AllowPrivilegeEscalation: &falseValue, ReadOnlyRootFilesystem: &trueValue, RunAsNonRoot: &trueValue, RunAsUser: &runAsUser,
			Capabilities: &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
		},
		Resources:      *resources,
		StartupProbe:   &corev1.Probe{ProbeHandler: corev1.ProbeHandler{TCPSocket: &corev1.TCPSocketAction{Port: intstr.FromString("host")}}, FailureThreshold: 30, PeriodSeconds: 2, TimeoutSeconds: 1},
		ReadinessProbe: &corev1.Probe{ProbeHandler: corev1.ProbeHandler{TCPSocket: &corev1.TCPSocketAction{Port: intstr.FromString("host")}}, FailureThreshold: 3, PeriodSeconds: 5, TimeoutSeconds: 2},
		LivenessProbe:  &corev1.Probe{ProbeHandler: corev1.ProbeHandler{TCPSocket: &corev1.TCPSocketAction{Port: intstr.FromString("host")}}, FailureThreshold: 3, PeriodSeconds: 10, TimeoutSeconds: 2},
	}
	if !r.OMPConfig.AllowUnauthenticated {
		container.Args = []string{r.OMPConfig.CredentialKey}
		container.Env = append(container.Env, corev1.EnvVar{
			Name: r.OMPConfig.CredentialKey,
			ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{
				LocalObjectReference: corev1.LocalObjectReference{Name: r.OMPConfig.CredentialSecretName},
				Key:                  r.OMPConfig.CredentialKey,
				Optional:             &falseValue,
			}},
		})
	}
	volumes := []corev1.Volume{
		{Name: "workspace", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: pvcName}}},
		{Name: "runtime", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{Medium: corev1.StorageMediumMemory, SizeLimit: ptrQuantity(apiresource.MustParse("128Mi"))}}},
		{Name: "temporary", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{SizeLimit: &temporarySize}}},
		{Name: "shared-memory", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{Medium: corev1.StorageMediumMemory, SizeLimit: &shmSize}}},
		{Name: "kubernetes-api-access", VolumeSource: corev1.VolumeSource{Projected: &corev1.ProjectedVolumeSource{
			DefaultMode: ptr(int32(0440)),
			Sources: []corev1.VolumeProjection{
				{ServiceAccountToken: &corev1.ServiceAccountTokenProjection{Audience: kubernetesAPIAudience, ExpirationSeconds: ptr(SessionReviewerTokenExpirationSeconds), Path: "token"}},
				{ConfigMap: &corev1.ConfigMapProjection{LocalObjectReference: corev1.LocalObjectReference{Name: "kube-root-ca.crt"}, Items: []corev1.KeyToPath{{Key: "ca.crt", Path: "ca.crt"}}}},
				{DownwardAPI: &corev1.DownwardAPIProjection{Items: []corev1.DownwardAPIVolumeFile{{Path: "namespace", FieldRef: &corev1.ObjectFieldSelector{APIVersion: "v1", FieldPath: "metadata.namespace"}}}}},
			},
		}}},
		{Name: "omp-config-source", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{
			LocalObjectReference: corev1.LocalObjectReference{Name: r.OMPConfig.ConfigMapName},
			DefaultMode:          ptr(int32(0440)),
			Optional:             &falseValue,
			Items: []corev1.KeyToPath{
				{Key: r.OMPConfig.ModelsKey, Path: "models.yml", Mode: ptr(int32(0440))},
				{Key: r.OMPConfig.SettingsKey, Path: "config.yml", Mode: ptr(int32(0440))},
			},
		}}},
	}
	if session.Spec.InitialPromptSecretRef != nil {
		volumes = append(volumes, corev1.Volume{Name: "initial-prompt", VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{SecretName: session.Spec.InitialPromptSecretRef.Name, Items: []corev1.KeyToPath{{Key: "prompt", Path: "prompt", Mode: ptr(int32(0440))}}}}})
		container.VolumeMounts = append(container.VolumeMounts, corev1.VolumeMount{Name: "initial-prompt", MountPath: "/run/t4-initial-prompt", ReadOnly: true})
		container.Env = append(container.Env, corev1.EnvVar{Name: "T4_INITIAL_PROMPT_FILE", Value: "/run/t4-initial-prompt/prompt"})
	}
	pod := corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: podName, Namespace: session.Namespace, Labels: labels},
		Spec: corev1.PodSpec{
			AutomountServiceAccountToken:  &falseValue,
			ServiceAccountName:            sessionServiceAccount,
			EnableServiceLinks:            &falseValue,
			TerminationGracePeriodSeconds: &grace,
			SecurityContext:               &corev1.PodSecurityContext{RunAsNonRoot: &trueValue, RunAsUser: &runAsUser, FSGroup: &fsGroup, SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault}},
			Affinity:                      &corev1.Affinity{NodeAffinity: &corev1.NodeAffinity{RequiredDuringSchedulingIgnoredDuringExecution: &corev1.NodeSelector{NodeSelectorTerms: []corev1.NodeSelectorTerm{{MatchExpressions: []corev1.NodeSelectorRequirement{{Key: "kubernetes.io/hostname", Operator: corev1.NodeSelectorOpNotIn, Values: excluded}}}}}}},
			Containers:                    []corev1.Container{container}, Volumes: volumes,
		},
	}
	hashInput, err := json.Marshal(struct {
		PodSpec             corev1.PodSpec      `json:"podSpec"`
		OMPResourceVersions ompResourceVersions `json:"ompResourceVersions"`
	}{PodSpec: pod.Spec, OMPResourceVersions: runtimeVersions})
	if err != nil {
		return corev1.Pod{}, fmt.Errorf("serialize desired session Pod: %w", err)
	}
	hash := sha256.Sum256(hashInput)
	pod.Annotations = map[string]string{clusterv1alpha1.SessionPodSpecHashAnnotation: fmt.Sprintf("%x", hash)}
	return pod, nil
}

func (r *SessionReconciler) updateSessionPending(ctx context.Context, session *clusterv1alpha1.T4Session, podName, serviceName, reason, message string) error {
	original := session.Status
	if session.Status.Conditions != nil {
		original.Conditions = append([]metav1.Condition(nil), session.Status.Conditions...)
	}
	session.Status.ObservedGeneration = session.Generation
	session.Status.PodName = podName
	session.Status.ServiceName = serviceName
	session.Status.Phase = clusterv1alpha1.InfrastructurePending
	meta.SetStatusCondition(&session.Status.Conditions, condition("Available", metav1.ConditionFalse, reason, message, session.Generation))
	if reflect.DeepEqual(original, session.Status) {
		return nil
	}
	return r.Status().Update(ctx, session)
}

func (r *SessionReconciler) reconcileDelete(ctx context.Context, session *clusterv1alpha1.T4Session) (ctrl.Result, error) {
	if !controllerutil.ContainsFinalizer(session, clusterv1alpha1.SessionFinalizer) {
		return ctrl.Result{}, nil
	}
	originalStatus := session.Status
	if session.Status.Conditions != nil {
		originalStatus.Conditions = append([]metav1.Condition(nil), session.Status.Conditions...)
	}
	session.Status.ObservedGeneration = session.Generation
	session.Status.Phase = clusterv1alpha1.InfrastructureTerminating
	meta.SetStatusCondition(&session.Status.Conditions, condition("Available", metav1.ConditionFalse, "Terminating", "session infrastructure is terminating", session.Generation))
	if !reflect.DeepEqual(originalStatus, session.Status) {
		if err := r.Status().Update(ctx, session); err != nil {
			return ctrl.Result{}, err
		}
	}
	objects := []client.Object{
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: SessionPodName(session), Namespace: session.Namespace}},
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: SessionServiceName(session), Namespace: session.Namespace}},
	}
	existing := make([]client.Object, 0, len(objects))
	for _, object := range objects {
		err := r.Get(ctx, client.ObjectKeyFromObject(object), object)
		if apierrors.IsNotFound(err) {
			continue
		}
		if err != nil {
			return ctrl.Result{}, err
		}
		if !metav1.IsControlledBy(object, session) {
			before := session.Status
			if session.Status.Conditions != nil {
				before.Conditions = append([]metav1.Condition(nil), session.Status.Conditions...)
			}
			meta.SetStatusCondition(&session.Status.Conditions, condition("Available", metav1.ConditionFalse, "CleanupOwnershipConflict", fmt.Sprintf("deterministic %T is not controlled by this session", object), session.Generation))
			if !reflect.DeepEqual(before, session.Status) {
				if err := r.Status().Update(ctx, session); err != nil {
					return ctrl.Result{}, err
				}
			}
			return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
		}
		existing = append(existing, object)
	}
	for _, object := range existing {
		if object.GetDeletionTimestamp().IsZero() {
			if err := r.Delete(ctx, object); err != nil && !apierrors.IsNotFound(err) {
				return ctrl.Result{}, err
			}
		}
	}
	if len(existing) > 0 {
		return ctrl.Result{RequeueAfter: time.Second}, nil
	}
	controllerutil.RemoveFinalizer(session, clusterv1alpha1.SessionFinalizer)
	return ctrl.Result{}, r.Update(ctx, session)
}

func (r *SessionReconciler) deleteOwnedSessionResources(ctx context.Context, session *clusterv1alpha1.T4Session) error {
	objects := []client.Object{
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: SessionPodName(session), Namespace: session.Namespace}},
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: SessionServiceName(session), Namespace: session.Namespace}},
	}
	for _, object := range objects {
		if err := r.Get(ctx, client.ObjectKeyFromObject(object), object); err != nil {
			if err := client.IgnoreNotFound(err); err != nil {
				return err
			}
			continue
		}
		if !metav1.IsControlledBy(object, session) {
			continue
		}
		if err := r.Delete(ctx, object); err != nil && !apierrors.IsNotFound(err) {
			return err
		}
	}
	return nil
}

func (r *SessionReconciler) updateSessionFailure(ctx context.Context, session *clusterv1alpha1.T4Session, conditionType, reason, message string) error {
	original := session.Status
	if session.Status.Conditions != nil {
		original.Conditions = append([]metav1.Condition(nil), session.Status.Conditions...)
	}
	session.Status.ObservedGeneration = session.Generation
	session.Status.PodName = ""
	session.Status.ServiceName = ""
	session.Status.Phase = clusterv1alpha1.InfrastructureFailed
	meta.SetStatusCondition(&session.Status.Conditions, condition(conditionType, metav1.ConditionFalse, reason, message, session.Generation))
	if conditionType != "Available" {
		meta.SetStatusCondition(&session.Status.Conditions, condition("Available", metav1.ConditionFalse, reason, message, session.Generation))
	}
	if reflect.DeepEqual(original, session.Status) {
		return nil
	}
	return r.Status().Update(ctx, session)
}

func serviceExposureIsInternal(service *corev1.Service) bool {
	if service.Spec.Type != corev1.ServiceTypeClusterIP || service.Spec.ClusterIP == corev1.ClusterIPNone || service.Spec.ExternalName != "" ||
		len(service.Spec.ExternalIPs) != 0 || service.Spec.LoadBalancerIP != "" || len(service.Spec.LoadBalancerSourceRanges) != 0 ||
		service.Spec.LoadBalancerClass != nil || service.Spec.HealthCheckNodePort != 0 || service.Spec.AllocateLoadBalancerNodePorts != nil {
		return false
	}
	for _, port := range service.Spec.Ports {
		if port.NodePort != 0 {
			return false
		}
	}
	return true
}

func labelsContain(actual, required map[string]string) bool {
	for key, value := range required {
		if actual[key] != value {
			return false
		}
	}
	return true
}

func (r *SessionReconciler) SetupWithManager(manager ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(manager).
		For(&clusterv1alpha1.T4Session{}).
		Owns(&corev1.Pod{}).
		Owns(&corev1.Service{}).
		Complete(r)
}

func podReady(pod *corev1.Pod) bool {
	for _, item := range pod.Status.Conditions {
		if item.Type == corev1.PodReady {
			return item.Status == corev1.ConditionTrue
		}
	}
	return false
}

func ptrQuantity(value apiresource.Quantity) *apiresource.Quantity { return &value }
func ptr[T any](value T) *T                                        { return &value }
