package controllers

import (
	"context"
	"errors"
	"fmt"
	"reflect"
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
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/handler"

	clusterv1alpha1 "github.com/wolfiesch/omperator/packages/cluster-operator/api/v1alpha1"
)

const (
	DefaultSessionServiceAccount                = "t4-cluster-session"
	DefaultServerServiceAccount                 = "t4-cluster-server"
	DefaultKubernetesAPIAudience                = "https://kubernetes.default.svc"
	SessionReviewerTokenExpirationSeconds int64 = 3600
)

const (
	sessionHostRefIndexField      = "t4.session.spec.hostRef"
	sessionWorkspaceRefIndexField = "t4.session.spec.workspaceRef"
)

var errSessionResourceOwnershipConflict = errors.New("session resource ownership conflict")

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
		if errors.Is(err, errSessionResourceOwnershipConflict) {
			result = ctrl.Result{RequeueAfter: 30 * time.Second}
			err = nil
		}
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
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, false, false, "RuntimeConfigured", reason, message)
	}
	if reason, message := r.OMPConfig.validationFailure(); reason != "" {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, false, false, "RuntimeConfigured", reason, message)
	}

	var host clusterv1alpha1.T4ClusterHost
	if err := r.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: session.Spec.HostRef}, &host); err != nil {
		if apierrors.IsNotFound(err) {
			if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
				return ctrl.Result{}, err
			}
			return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, false, false, "HostReady", "HostNotFound", "referenced T4ClusterHost does not exist")
		}
		return ctrl.Result{}, err
	}
	if !hasString(host.Spec.RuntimeProfiles, session.Spec.RuntimeProfile) {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, true, false, "RuntimeConfigured", "RuntimeProfileNotAllowed", "runtime profile is not allowed by the referenced T4ClusterHost")
	}
	var storageClass storagev1.StorageClass
	if err := r.Get(ctx, types.NamespacedName{Name: host.Spec.StorageClassName}, &storageClass); err != nil {
		if apierrors.IsNotFound(err) {
			if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
				return ctrl.Result{}, err
			}
			return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, true, false, "WorkspaceReady", ReasonStorageClassNotFound, fmt.Sprintf("StorageClass %q selected by the referenced T4ClusterHost does not exist", host.Spec.StorageClassName))
		}
		return ctrl.Result{}, err
	}
	if !storageClassAllowsRWX(storageClass.Annotations) {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, true, false, "WorkspaceReady", ReasonStorageClassNotRWX, fmt.Sprintf("StorageClass %q selected by the referenced T4ClusterHost is not administrator-declared ReadWriteMany", host.Spec.StorageClassName))
	}
	var workspace clusterv1alpha1.T4Workspace
	if err := r.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: session.Spec.WorkspaceRef}, &workspace); err != nil {
		if apierrors.IsNotFound(err) {
			if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
				return ctrl.Result{}, err
			}
			return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, true, false, "WorkspaceReady", "WorkspaceNotFound", "referenced T4Workspace does not exist")
		}
		return ctrl.Result{}, err
	}
	if workspace.Spec.HostRef != session.Spec.HostRef {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, true, false, "WorkspaceReady", "HostMismatch", "session and workspace must reference the same T4ClusterHost")
	}
	if workspace.Status.PVCName == "" {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 5 * time.Second}, r.updateSessionFailure(ctx, &session, true, false, "WorkspaceReady", "PVCNotDeclared", "workspace controller has not declared a PVC")
	}
	if workspace.UID != "" && workspace.Status.PVCName != WorkspacePVCName(&workspace) {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, true, false, "WorkspaceReady", "PVCIdentityMismatch", "workspace status does not reference its deterministic PVC")
	}
	var pvc corev1.PersistentVolumeClaim
	if err := r.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: workspace.Status.PVCName}, &pvc); err != nil {
		if apierrors.IsNotFound(err) {
			if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
				return ctrl.Result{}, err
			}
			return ctrl.Result{RequeueAfter: 5 * time.Second}, r.updateSessionFailure(ctx, &session, true, false, "WorkspaceReady", "PVCNotFound", "workspace PVC does not exist")
		}
		return ctrl.Result{}, err
	}
	if workspace.UID != "" && !workspaceOwnsPVC(&workspace, &pvc) {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, true, false, "WorkspaceReady", "PVCOwnershipConflict", "workspace PVC identity or ownership is not authoritative")
	}
	if pvcStorageClassName(&pvc) != host.Spec.StorageClassName {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, true, false, "WorkspaceReady", ReasonStorageClassMismatch, fmt.Sprintf("workspace PVC uses StorageClass %q instead of host-selected %q", pvcStorageClassName(&pvc), host.Spec.StorageClassName))
	}
	if pvc.Status.Phase != corev1.ClaimBound || !pvcHasRWX(&pvc) {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 5 * time.Second}, r.updateSessionFailure(ctx, &session, true, false, "WorkspaceReady", "PVCNotBoundRWX", "workspace PVC must be Bound and ReadWriteMany before a session starts")
	}
	runtimeVersions, reason, message, err := r.loadOMPResourceVersions(ctx, session.Namespace)
	if err != nil {
		return ctrl.Result{}, err
	}
	if reason != "" {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, true, true, "RuntimeConfigured", reason, message)
	}
	reason, message, err = r.authoritativePVCValidation(ctx, &workspace, &pvc, host.Spec.StorageClassName)
	if err != nil {
		return ctrl.Result{}, err
	}
	if reason != "" {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, true, false, "WorkspaceReady", reason, message)
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
	serviceKey := types.NamespacedName{Namespace: session.Namespace, Name: serviceName}
	if err := r.Get(ctx, serviceKey, &service); apierrors.IsNotFound(err) {
		service = desiredService
		if err := r.Create(ctx, &service); err != nil {
			if !apierrors.IsAlreadyExists(err) {
				return ctrl.Result{}, err
			}
			reader := r.APIReader
			if reader == nil {
				reader = r.Client
			}
			if err := reader.Get(ctx, serviceKey, &service); err != nil {
				return ctrl.Result{}, err
			}
		}
	} else if err != nil {
		return ctrl.Result{}, err
	}
	if !sessionExclusivelyOwnsResource(&service, &session) {
		if err := r.deleteOwnedSessionResourcesAfterVerifiedDependencies(ctx, &session, "ServiceOwnershipConflict", "deterministic session Service has an unexpected owner"); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
	} else if !serviceExposureIsInternal(&service) {
		if err := deleteWithPreconditions(ctx, r.Client, &service); err != nil && !apierrors.IsNotFound(err) {
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
	podKey := types.NamespacedName{Namespace: session.Namespace, Name: podName}
	if err := r.Get(ctx, podKey, &pod); apierrors.IsNotFound(err) {
		reason, message, err := r.authoritativePVCValidation(ctx, &workspace, &pvc, host.Spec.StorageClassName)
		if err != nil {
			return ctrl.Result{}, err
		}
		if reason != "" {
			if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
				return ctrl.Result{}, err
			}
			return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, true, false, "WorkspaceReady", reason, message)
		}
		pod = desiredPod
		if err := r.Create(ctx, &pod); err != nil {
			if !apierrors.IsAlreadyExists(err) {
				return ctrl.Result{}, err
			}
			reader := r.APIReader
			if reader == nil {
				reader = r.Client
			}
			if err := reader.Get(ctx, podKey, &pod); err != nil {
				return ctrl.Result{}, err
			}
		}
	} else if err != nil {
		return ctrl.Result{}, err
	}
	if !sessionExclusivelyOwnsResource(&pod, &session) {
		if err := r.deleteOwnedSessionResourcesAfterVerifiedDependencies(ctx, &session, "PodOwnershipConflict", "deterministic session Pod has an unexpected owner"); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
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
		if err := deleteWithPreconditions(ctx, r.Client, &pod); err != nil && !apierrors.IsNotFound(err) {
			return ctrl.Result{}, err
		}
		if err := r.updateSessionPending(ctx, &session, podName, serviceName, "PodSpecChanged", "session Pod is being recreated to apply immutable desired state"); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: time.Second}, nil
	}

	reason, message, err = r.authoritativePVCValidation(ctx, &workspace, &pvc, host.Spec.StorageClassName)
	if err != nil {
		return ctrl.Result{}, err
	}
	if reason != "" {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, true, false, "WorkspaceReady", reason, message)
	}

	original := session.Status
	if session.Status.Conditions != nil {
		original.Conditions = append([]metav1.Condition(nil), session.Status.Conditions...)
	}
	session.Status.ObservedGeneration = session.Generation
	session.Status.PodName = podName
	session.Status.ServiceName = serviceName
	meta.SetStatusCondition(&session.Status.Conditions, condition("HostReady", metav1.ConditionTrue, "HostResolved", "referenced T4ClusterHost is available", session.Generation))
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

func (r *SessionReconciler) authoritativePVCValidation(ctx context.Context, workspace *clusterv1alpha1.T4Workspace, cachedPVC *corev1.PersistentVolumeClaim, storageClassName string) (string, string, error) {
	reader := r.APIReader
	if reader == nil {
		reader = r.Client
	}
	var authoritativePVC corev1.PersistentVolumeClaim
	if err := reader.Get(ctx, client.ObjectKeyFromObject(cachedPVC), &authoritativePVC); err != nil {
		if apierrors.IsNotFound(err) {
			return "PVCAuthorityChanged", "workspace PVC does not exist in authoritative API state", nil
		}
		return "", "", err
	}
	if authoritativePVC.UID != cachedPVC.UID {
		return "PVCAuthorityChanged", "authoritative workspace PVC UID differs from the validated cached PVC", nil
	}
	if workspace.UID != "" && !workspaceOwnsPVC(workspace, &authoritativePVC) {
		return "PVCAuthorityChanged", "authoritative workspace PVC owner reference does not belong to the workspace", nil
	}
	if pvcStorageClassName(&authoritativePVC) != storageClassName {
		return "PVCAuthorityChanged", fmt.Sprintf("authoritative workspace PVC uses StorageClass %q instead of host-selected %q", pvcStorageClassName(&authoritativePVC), storageClassName), nil
	}
	if !pvcHasRWX(&authoritativePVC) {
		return "PVCAuthorityChanged", "authoritative workspace PVC does not request ReadWriteMany", nil
	}
	if authoritativePVC.Status.Phase != corev1.ClaimBound {
		return "PVCAuthorityChanged", "authoritative workspace PVC is not Bound", nil
	}
	return "", "", nil
}

func (r *SessionReconciler) updateSessionPending(ctx context.Context, session *clusterv1alpha1.T4Session, podName, serviceName, reason, message string) error {
	original := session.Status
	if session.Status.Conditions != nil {
		original.Conditions = append([]metav1.Condition(nil), session.Status.Conditions...)
	}
	session.Status.ObservedGeneration = session.Generation
	meta.SetStatusCondition(&session.Status.Conditions, condition("HostReady", metav1.ConditionTrue, "HostResolved", "referenced T4ClusterHost is available", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("WorkspaceReady", metav1.ConditionTrue, "PVCBoundRWX", "workspace PVC is Bound and ReadWriteMany", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("RuntimeConfigured", metav1.ConditionTrue, "OMPReferencesReady", "administrator-owned OMP runtime references are configured", session.Generation))
	session.Status.PodName = podName
	session.Status.ServiceName = serviceName
	session.Status.Phase = clusterv1alpha1.InfrastructurePending
	meta.SetStatusCondition(&session.Status.Conditions, condition("Available", metav1.ConditionFalse, reason, message, session.Generation))
	if reflect.DeepEqual(original, session.Status) {
		return nil
	}
	return r.Status().Update(ctx, session)
}

func indexSessionByHostRef(object client.Object) []string {
	session, ok := object.(*clusterv1alpha1.T4Session)
	if !ok || session.Spec.HostRef == "" {
		return nil
	}
	return []string{session.Spec.HostRef}
}

func indexSessionByWorkspaceRef(object client.Object) []string {
	session, ok := object.(*clusterv1alpha1.T4Session)
	if !ok || session.Spec.WorkspaceRef == "" {
		return nil
	}
	return []string{session.Spec.WorkspaceRef}
}

func (r *SessionReconciler) sessionRequestsForHost(ctx context.Context, object client.Object) []ctrl.Request {
	host, ok := object.(*clusterv1alpha1.T4ClusterHost)
	if !ok || host.Name == "" || host.Namespace == "" {
		return nil
	}
	return r.sessionRequestsForReference(ctx, host.Namespace, sessionHostRefIndexField, host.Name, "clusterHost", client.ObjectKeyFromObject(host))
}

func (r *SessionReconciler) sessionRequestsForWorkspace(ctx context.Context, object client.Object) []ctrl.Request {
	workspace, ok := object.(*clusterv1alpha1.T4Workspace)
	if !ok || workspace.Name == "" || workspace.Namespace == "" {
		return nil
	}
	return r.sessionRequestsForReference(ctx, workspace.Namespace, sessionWorkspaceRefIndexField, workspace.Name, "workspace", client.ObjectKeyFromObject(workspace))
}

func (r *SessionReconciler) sessionRequestsForReference(ctx context.Context, namespace, field, value, dependencyKind string, dependencyKey types.NamespacedName) []ctrl.Request {
	var sessions clusterv1alpha1.T4SessionList
	if err := r.List(ctx, &sessions, client.InNamespace(namespace), client.MatchingFields{field: value}); err != nil {
		ctrl.LoggerFrom(ctx).Error(err, "unable to map dependency to sessions", dependencyKind, dependencyKey)
		return nil
	}
	requests := make([]ctrl.Request, 0, len(sessions.Items))
	for i := range sessions.Items {
		requests = append(requests, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(&sessions.Items[i])})
	}
	return requests
}

func (r *SessionReconciler) SetupWithManager(manager ctrl.Manager) error {
	if err := manager.GetFieldIndexer().IndexField(context.Background(), &clusterv1alpha1.T4Session{}, sessionHostRefIndexField, indexSessionByHostRef); err != nil {
		return fmt.Errorf("index T4Session by host reference: %w", err)
	}
	if err := manager.GetFieldIndexer().IndexField(context.Background(), &clusterv1alpha1.T4Session{}, sessionWorkspaceRefIndexField, indexSessionByWorkspaceRef); err != nil {
		return fmt.Errorf("index T4Session by workspace reference: %w", err)
	}
	return ctrl.NewControllerManagedBy(manager).
		For(&clusterv1alpha1.T4Session{}).
		Watches(&clusterv1alpha1.T4ClusterHost{}, handler.EnqueueRequestsFromMapFunc(r.sessionRequestsForHost)).
		Watches(&clusterv1alpha1.T4Workspace{}, handler.EnqueueRequestsFromMapFunc(r.sessionRequestsForWorkspace)).
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
