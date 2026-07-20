package controllers

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"reflect"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	meta "k8s.io/apimachinery/pkg/api/meta"
	apiresource "k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	intstr "k8s.io/apimachinery/pkg/util/intstr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	clusterv1alpha1 "github.com/LycaonLLC/t4-code/packages/cluster-operator/api/v1alpha1"
)

const (
	DefaultSessionServiceAccount                = "t4-cluster-session"
	DefaultServerServiceAccount                 = "t4-cluster-server"
	KubernetesAPIAudience                       = "https://kubernetes.default.svc"
	SessionReviewerTokenExpirationSeconds int64 = 3600
)

type SessionReconciler struct {
	client.Client
	Scheme                    *runtime.Scheme
	RuntimeImage              string
	SessionServiceAccountName string
	ServerServiceAccountName  string
	ExcludedNodeNames         []string
	Resources                 corev1.ResourceRequirements
	SharedMemorySize          apiresource.Quantity
	TemporarySize             apiresource.Quantity
}

func (r *SessionReconciler) Reconcile(ctx context.Context, request ctrl.Request) (ctrl.Result, error) {
	var session clusterv1alpha1.T4Session
	if err := r.Get(ctx, request.NamespacedName, &session); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	if !session.DeletionTimestamp.IsZero() {
		return r.reconcileDelete(ctx, &session)
	}
	if controllerutil.AddFinalizer(&session, clusterv1alpha1.SessionFinalizer) {
		if err := r.Update(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
	}
	if r.RuntimeImage == "" {
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, "RuntimeConfigured", "RuntimeImageMissing", "administrator-owned session runtime image is not configured")
	}

	var host clusterv1alpha1.T4ClusterHost
	if err := r.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: session.Spec.HostRef}, &host); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, "HostReady", "HostNotFound", "referenced T4ClusterHost does not exist")
		}
		return ctrl.Result{}, err
	}
	if !hasString(host.Spec.RuntimeProfiles, session.Spec.RuntimeProfile) {
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, "RuntimeConfigured", "RuntimeProfileNotAllowed", "runtime profile is not allowed by the referenced T4ClusterHost")
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
	} else if !reflect.DeepEqual(service.Spec.Selector, desiredService.Spec.Selector) || !reflect.DeepEqual(service.Spec.Ports, desiredService.Spec.Ports) || !reflect.DeepEqual(service.Labels, desiredService.Labels) {
		service.Spec.Selector = desiredService.Spec.Selector
		service.Spec.Ports = desiredService.Spec.Ports
		service.Labels = desiredService.Labels
		if err := r.Update(ctx, &service); err != nil {
			return ctrl.Result{}, err
		}
	}

	desiredPod, err := r.desiredPod(&session, workspace.Status.PVCName, podName, labels)
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
	return ctrl.Result{}, nil
}

func (r *SessionReconciler) desiredPod(session *clusterv1alpha1.T4Session, pvcName, podName string, labels map[string]string) (corev1.Pod, error) {
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
			{Name: "T4_SESSION_NAME", Value: session.Name},
			{Name: "T4_WORKSPACE_ROOT", Value: "/workspace"},
			{Name: "T4_SESSION_STATE_ROOT", Value: "/workspace/.t4/sessions/" + stateID},
			{Name: "T4_AUTHORITY_STATE_DIR", Value: "/workspace/.t4/sessions/" + stateID + "/authority"},
			{Name: "T4_BROWSER_STATE_DIR", Value: "/workspace/.t4/sessions/" + stateID + "/browser"},
			{Name: "T4_GUI_ENABLED", Value: fmt.Sprintf("%t", session.Spec.GUIEnabled)},
			{Name: "DISPLAY", Value: ":99"},
		},
		VolumeMounts: []corev1.VolumeMount{
			{Name: "workspace", MountPath: "/workspace"},
			{Name: "runtime", MountPath: "/run"},
			{Name: "temporary", MountPath: "/tmp"},
			{Name: "shared-memory", MountPath: "/dev/shm"},
			{Name: "kubernetes-api-access", MountPath: "/var/run/secrets/kubernetes.io/serviceaccount", ReadOnly: true},
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
				{ServiceAccountToken: &corev1.ServiceAccountTokenProjection{Audience: KubernetesAPIAudience, ExpirationSeconds: ptr(SessionReviewerTokenExpirationSeconds), Path: "token"}},
				{ConfigMap: &corev1.ConfigMapProjection{LocalObjectReference: corev1.LocalObjectReference{Name: "kube-root-ca.crt"}, Items: []corev1.KeyToPath{{Key: "ca.crt", Path: "ca.crt"}}}},
				{DownwardAPI: &corev1.DownwardAPIProjection{Items: []corev1.DownwardAPIVolumeFile{{Path: "namespace", FieldRef: &corev1.ObjectFieldSelector{APIVersion: "v1", FieldPath: "metadata.namespace"}}}}},
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
	spec, err := json.Marshal(pod.Spec)
	if err != nil {
		return corev1.Pod{}, fmt.Errorf("serialize desired session Pod: %w", err)
	}
	hash := sha256.Sum256(spec)
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
	remaining := false
	for _, object := range []client.Object{
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: SessionPodName(session), Namespace: session.Namespace}},
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: SessionServiceName(session), Namespace: session.Namespace}},
	} {
		err := r.Get(ctx, client.ObjectKeyFromObject(object), object)
		if err == nil {
			remaining = true
			if object.GetDeletionTimestamp().IsZero() {
				if err := r.Delete(ctx, object); err != nil && !apierrors.IsNotFound(err) {
					return ctrl.Result{}, err
				}
			}
		} else if !apierrors.IsNotFound(err) {
			return ctrl.Result{}, err
		}
	}
	if remaining {
		return ctrl.Result{RequeueAfter: time.Second}, nil
	}
	controllerutil.RemoveFinalizer(session, clusterv1alpha1.SessionFinalizer)
	return ctrl.Result{}, r.Update(ctx, session)
}

func (r *SessionReconciler) updateSessionFailure(ctx context.Context, session *clusterv1alpha1.T4Session, conditionType, reason, message string) error {
	original := session.Status
	if session.Status.Conditions != nil {
		original.Conditions = append([]metav1.Condition(nil), session.Status.Conditions...)
	}
	session.Status.ObservedGeneration = session.Generation
	session.Status.Phase = clusterv1alpha1.InfrastructureFailed
	meta.SetStatusCondition(&session.Status.Conditions, condition(conditionType, metav1.ConditionFalse, reason, message, session.Generation))
	if reflect.DeepEqual(original, session.Status) {
		return nil
	}
	return r.Status().Update(ctx, session)
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
