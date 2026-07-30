package controllers

import (
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
	apiresource "k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	intstr "k8s.io/apimachinery/pkg/util/intstr"

	clusterv1alpha1 "github.com/wolfiesch/omperator/packages/cluster-operator/api/v1alpha1"
)

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
