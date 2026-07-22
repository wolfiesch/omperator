package controllers

import (
	"context"
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
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/handler"

	clusterv1alpha1 "github.com/LycaonLLC/t4-code/packages/cluster-operator/api/v1alpha1"
)

type WorkspaceReconciler struct {
	client.Client
	APIReader client.Reader
	Scheme    *runtime.Scheme
}

const (
	workspacePVCPartOfLabel    = "app.kubernetes.io/part-of"
	workspacePVCPartOfValue    = "t4-cluster"
	workspacePVCWorkspaceLabel = "cluster.t4.dev/workspace"
	hostStorageClassIndexField = "t4.workspace.host.storageClassName"
	workspaceHostRefIndexField = "t4.workspace.spec.hostRef"
)

func (r *WorkspaceReconciler) Reconcile(ctx context.Context, request ctrl.Request) (result ctrl.Result, err error) {
	var workspace clusterv1alpha1.T4Workspace
	found := false
	defer func() {
		observeReconcile(metricKindWorkspace, request.NamespacedName, workspace.Status.Conditions, conditionObjectPresent(&workspace, found, err), err)
	}()
	if err := r.Get(ctx, request.NamespacedName, &workspace); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	found = true
	if !workspace.DeletionTimestamp.IsZero() {
		return r.reconcileDelete(ctx, &workspace)
	}
	if controllerutil.AddFinalizer(&workspace, clusterv1alpha1.WorkspaceFinalizer) {
		if err := r.Update(ctx, &workspace); err != nil {
			return ctrl.Result{}, err
		}
	}

	var host clusterv1alpha1.T4ClusterHost
	if err := r.Get(ctx, types.NamespacedName{Namespace: workspace.Namespace, Name: workspace.Spec.HostRef}, &host); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateWorkspaceFailure(ctx, &workspace, "HostReady", "HostNotFound", "referenced T4ClusterHost does not exist")
		}
		return ctrl.Result{}, err
	}
	storageClassName := host.Spec.StorageClassName
	var storageClass storagev1.StorageClass
	if err := r.Get(ctx, types.NamespacedName{Name: storageClassName}, &storageClass); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateWorkspaceFailure(ctx, &workspace, "StorageReady", ReasonStorageClassNotFound, fmt.Sprintf("StorageClass %q does not exist", storageClassName))
		}
		return ctrl.Result{}, err
	}
	if !storageClassAllowsRWX(storageClass.Annotations) {
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateWorkspaceFailure(ctx, &workspace, "StorageReady", ReasonStorageClassNotRWX, fmt.Sprintf("StorageClass %q is not administrator-declared ReadWriteMany", storageClassName))
	}

	pvcName := WorkspacePVCName(&workspace)
	pvcKey := types.NamespacedName{Namespace: workspace.Namespace, Name: pvcName}
	var pvc corev1.PersistentVolumeClaim
	err = r.Get(ctx, pvcKey, &pvc)
	if apierrors.IsNotFound(err) {
		volumeMode := corev1.PersistentVolumeFilesystem
		pvc = corev1.PersistentVolumeClaim{
			ObjectMeta: metav1.ObjectMeta{
				Name: pvcName, Namespace: workspace.Namespace,
				Labels: map[string]string{
					workspacePVCPartOfLabel:    workspacePVCPartOfValue,
					workspacePVCWorkspaceLabel: workspace.Name,
				},
				Annotations: map[string]string{clusterv1alpha1.WorkspaceUIDAnnotation: string(workspace.UID)},
			},
			Spec: corev1.PersistentVolumeClaimSpec{
				AccessModes:      []corev1.PersistentVolumeAccessMode{corev1.ReadWriteMany},
				StorageClassName: &storageClassName,
				VolumeMode:       &volumeMode,
				Resources:        corev1.VolumeResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceStorage: workspace.Spec.Size.DeepCopy()}},
			},
		}
		if workspace.Spec.RetentionPolicy == clusterv1alpha1.RetentionPolicyDelete {
			if err := controllerutil.SetControllerReference(&workspace, &pvc, r.Scheme); err != nil {
				return ctrl.Result{}, err
			}
		}
		if err := r.Create(ctx, &pvc); err != nil {
			if !apierrors.IsAlreadyExists(err) {
				return ctrl.Result{}, err
			}
			reader := r.APIReader
			if reader == nil {
				reader = r.Client
			}
			if err := reader.Get(ctx, pvcKey, &pvc); err != nil {
				return ctrl.Result{}, err
			}
		}
	} else if err != nil {
		return ctrl.Result{}, err
	}
	if !workspaceOwnsPVC(&workspace, &pvc) {
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateWorkspaceFailure(ctx, &workspace, "StorageReady", "PVCOwnershipConflict", "deterministic workspace PVC does not belong to this workspace")
	} else if !pvcHasRWX(&pvc) {
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateWorkspaceFailure(ctx, &workspace, "StorageReady", "PVCNotRWX", "workspace PVC does not request ReadWriteMany")
	} else if pvcStorageClassName(&pvc) != storageClassName {
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateWorkspaceFailure(ctx, &workspace, "StorageReady", ReasonStorageClassMismatch, fmt.Sprintf("workspace PVC uses StorageClass %q instead of host-selected %q; data-bearing PVCs are never recreated automatically", pvcStorageClassName(&pvc), storageClassName))
	} else if workspace.Spec.RetentionPolicy == clusterv1alpha1.RetentionPolicyRetain && metav1.IsControlledBy(&pvc, &workspace) {
		before := pvc.DeepCopy()
		pvc.OwnerReferences = removeWorkspaceOwnerReference(pvc.OwnerReferences, workspace.UID)
		if !reflect.DeepEqual(before.OwnerReferences, pvc.OwnerReferences) {
			if err := r.Update(ctx, &pvc); err != nil {
				return ctrl.Result{}, err
			}
			return ctrl.Result{Requeue: true}, nil
		}
	}
	reader := r.APIReader
	if reader == nil {
		reader = r.Client
	}
	var authoritativePVC corev1.PersistentVolumeClaim
	if err := reader.Get(ctx, pvcKey, &authoritativePVC); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{RequeueAfter: 5 * time.Second}, r.updateWorkspaceFailure(ctx, &workspace, "StorageReady", "PVCNotFound", "workspace PVC does not exist in authoritative API state")
		}
		return ctrl.Result{}, err
	}
	if authoritativePVC.UID != pvc.UID || !workspaceOwnsPVC(&workspace, &authoritativePVC) {
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateWorkspaceFailure(ctx, &workspace, "StorageReady", "PVCOwnershipConflict", "authoritative workspace PVC identity or ownership does not belong to this workspace")
	}
	if !pvcHasRWX(&authoritativePVC) {
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateWorkspaceFailure(ctx, &workspace, "StorageReady", "PVCNotRWX", "authoritative workspace PVC does not request ReadWriteMany")
	}
	if pvcStorageClassName(&authoritativePVC) != storageClassName {
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateWorkspaceFailure(ctx, &workspace, "StorageReady", ReasonStorageClassMismatch, fmt.Sprintf("authoritative workspace PVC uses StorageClass %q instead of host-selected %q; data-bearing PVCs are never recreated automatically", pvcStorageClassName(&authoritativePVC), storageClassName))
	}
	pvc = authoritativePVC

	if pvc.Status.Phase == corev1.ClaimLost {
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateWorkspaceFailure(ctx, &workspace, "StorageReady", "PVCLost", "workspace PVC lost its volume")
	}

	original := workspace.Status
	original.Capacity = workspace.Status.Capacity.DeepCopy()
	if workspace.Status.Conditions != nil {
		original.Conditions = append([]metav1.Condition(nil), workspace.Status.Conditions...)
	}
	workspace.Status.ObservedGeneration = workspace.Generation
	workspace.Status.PVCName = pvcName
	workspace.Status.PVCPhase = pvc.Status.Phase
	capacity := pvc.Status.Capacity[corev1.ResourceStorage]
	workspace.Status.Capacity = capacity.DeepCopy()
	meta.SetStatusCondition(&workspace.Status.Conditions, condition("HostReady", metav1.ConditionTrue, "HostResolved", "referenced T4ClusterHost is available", workspace.Generation))
	meta.SetStatusCondition(&workspace.Status.Conditions, condition("StorageReady", metav1.ConditionTrue, ReasonStorageReady, "RWX StorageClass and workspace PVC are accepted", workspace.Generation))
	switch pvc.Status.Phase {
	case corev1.ClaimBound:
		workspace.Status.Phase = clusterv1alpha1.InfrastructureReady
		meta.SetStatusCondition(&workspace.Status.Conditions, condition("Ready", metav1.ConditionTrue, "PVCBound", "workspace PVC is bound with ReadWriteMany access", workspace.Generation))
	default:
		workspace.Status.Phase = clusterv1alpha1.InfrastructurePending
		meta.SetStatusCondition(&workspace.Status.Conditions, condition("Ready", metav1.ConditionFalse, "PVCBinding", "workspace PVC is waiting to bind", workspace.Generation))
	}
	if !reflect.DeepEqual(original, workspace.Status) {
		if err := r.Status().Update(ctx, &workspace); err != nil {
			return ctrl.Result{}, err
		}
	}
	if pvc.Status.Phase != corev1.ClaimBound {
		return ctrl.Result{RequeueAfter: 5 * time.Second}, nil
	}
	return ctrl.Result{}, nil
}

func workspaceOwnsPVC(workspace *clusterv1alpha1.T4Workspace, pvc *corev1.PersistentVolumeClaim) bool {
	if pvc.Annotations[clusterv1alpha1.WorkspaceUIDAnnotation] != string(workspace.UID) {
		return false
	}
	for _, reference := range pvc.OwnerReferences {
		if reference.APIVersion != clusterv1alpha1.GroupVersion.String() || reference.Kind != "T4Workspace" || reference.Name != workspace.Name || reference.UID != workspace.UID {
			return false
		}
	}
	controller := metav1.GetControllerOf(pvc)
	if workspace.Spec.RetentionPolicy == clusterv1alpha1.RetentionPolicyDelete {
		return controller != nil && controller.UID == workspace.UID
	}
	return controller == nil || controller.UID == workspace.UID
}

func removeWorkspaceOwnerReference(references []metav1.OwnerReference, uid types.UID) []metav1.OwnerReference {
	output := references[:0]
	for _, reference := range references {
		if reference.UID != uid {
			output = append(output, reference)
		}
	}
	return output
}

func (r *WorkspaceReconciler) reconcileDelete(ctx context.Context, workspace *clusterv1alpha1.T4Workspace) (ctrl.Result, error) {
	if !controllerutil.ContainsFinalizer(workspace, clusterv1alpha1.WorkspaceFinalizer) {
		return ctrl.Result{}, nil
	}
	originalStatus := workspace.Status
	if workspace.Status.Conditions != nil {
		originalStatus.Conditions = append([]metav1.Condition(nil), workspace.Status.Conditions...)
	}
	workspace.Status.ObservedGeneration = workspace.Generation
	workspace.Status.Phase = clusterv1alpha1.InfrastructureTerminating
	meta.SetStatusCondition(&workspace.Status.Conditions, condition("Ready", metav1.ConditionFalse, "Terminating", "workspace infrastructure is terminating", workspace.Generation))
	if !reflect.DeepEqual(originalStatus, workspace.Status) {
		if err := r.Status().Update(ctx, workspace); err != nil {
			return ctrl.Result{}, err
		}
	}
	var sessions clusterv1alpha1.T4SessionList
	sessionReader := r.APIReader
	if sessionReader == nil {
		sessionReader = r.Client
	}
	if err := sessionReader.List(ctx, &sessions, client.InNamespace(workspace.Namespace)); err != nil {
		return ctrl.Result{}, err
	}
	remainingSessions := 0
	for i := range sessions.Items {
		if sessions.Items[i].Spec.WorkspaceRef == workspace.Name {
			remainingSessions++
		}
	}
	if remainingSessions > 0 {
		before := workspace.Status
		if workspace.Status.Conditions != nil {
			before.Conditions = append([]metav1.Condition(nil), workspace.Status.Conditions...)
		}
		meta.SetStatusCondition(&workspace.Status.Conditions, condition("Ready", metav1.ConditionFalse, "SessionsRemain", fmt.Sprintf("workspace deletion is waiting for %d session resources", remainingSessions), workspace.Generation))
		if !reflect.DeepEqual(before, workspace.Status) {
			if err := r.Status().Update(ctx, workspace); err != nil {
				return ctrl.Result{}, err
			}
		}
		return ctrl.Result{RequeueAfter: 5 * time.Second}, nil
	}
	pvcKey := types.NamespacedName{Namespace: workspace.Namespace, Name: WorkspacePVCName(workspace)}
	var pvc corev1.PersistentVolumeClaim
	reader := r.APIReader
	if reader == nil {
		reader = r.Client
	}
	err := reader.Get(ctx, pvcKey, &pvc)
	if err == nil && !workspaceOwnsPVC(workspace, &pvc) {
		before := workspace.Status
		if workspace.Status.Conditions != nil {
			before.Conditions = append([]metav1.Condition(nil), workspace.Status.Conditions...)
		}
		meta.SetStatusCondition(&workspace.Status.Conditions, condition("Ready", metav1.ConditionFalse, "CleanupOwnershipConflict", "deterministic workspace PVC does not belong to this workspace", workspace.Generation))
		if !reflect.DeepEqual(before, workspace.Status) {
			if err := r.Status().Update(ctx, workspace); err != nil {
				return ctrl.Result{}, err
			}
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
	}
	if workspace.Spec.RetentionPolicy == clusterv1alpha1.RetentionPolicyRetain {
		if err == nil {
			before := pvc.DeepCopy()
			pvc.OwnerReferences = removeWorkspaceOwnerReference(pvc.OwnerReferences, workspace.UID)
			if pvc.Annotations == nil {
				pvc.Annotations = map[string]string{}
			}
			pvc.Annotations[clusterv1alpha1.RetainedPVCAnnotation] = "true"
			if !reflect.DeepEqual(before.ObjectMeta, pvc.ObjectMeta) {
				if err := r.Update(ctx, &pvc); err != nil {
					return ctrl.Result{}, err
				}
			}
		} else if !apierrors.IsNotFound(err) {
			return ctrl.Result{}, err
		}
	} else {
		if err == nil {
			if err := deleteWithPreconditions(ctx, r.Client, &pvc); err != nil && !apierrors.IsNotFound(err) {
				return ctrl.Result{}, err
			}
			return ctrl.Result{RequeueAfter: time.Second}, nil
		}
		if !apierrors.IsNotFound(err) {
			return ctrl.Result{}, err
		}
	}
	controllerutil.RemoveFinalizer(workspace, clusterv1alpha1.WorkspaceFinalizer)
	return ctrl.Result{}, r.Update(ctx, workspace)
}

func (r *WorkspaceReconciler) updateWorkspaceFailure(ctx context.Context, workspace *clusterv1alpha1.T4Workspace, conditionType, reason, message string) error {
	original := workspace.Status
	original.Capacity = workspace.Status.Capacity.DeepCopy()
	if workspace.Status.Conditions != nil {
		original.Conditions = append([]metav1.Condition(nil), workspace.Status.Conditions...)
	}
	workspace.Status.ObservedGeneration = workspace.Generation
	workspace.Status.PVCName = ""
	workspace.Status.PVCPhase = ""
	workspace.Status.Capacity = apiresource.Quantity{}
	workspace.Status.Phase = clusterv1alpha1.InfrastructureFailed
	if conditionType == "HostReady" {
		meta.SetStatusCondition(&workspace.Status.Conditions, condition("HostReady", metav1.ConditionFalse, reason, message, workspace.Generation))
		meta.SetStatusCondition(&workspace.Status.Conditions, condition("StorageReady", metav1.ConditionUnknown, "NotEvaluated", "storage dependency was not evaluated because the referenced host is unavailable", workspace.Generation))
	} else {
		meta.SetStatusCondition(&workspace.Status.Conditions, condition("HostReady", metav1.ConditionTrue, "HostResolved", "referenced T4ClusterHost is available", workspace.Generation))
		meta.SetStatusCondition(&workspace.Status.Conditions, condition("StorageReady", metav1.ConditionFalse, reason, message, workspace.Generation))
	}
	meta.SetStatusCondition(&workspace.Status.Conditions, condition("Ready", metav1.ConditionFalse, reason, message, workspace.Generation))
	if reflect.DeepEqual(original, workspace.Status) {
		return nil
	}
	return r.Status().Update(ctx, workspace)
}

func workspaceRequestsForPVC(_ context.Context, object client.Object) []ctrl.Request {
	pvc, ok := object.(*corev1.PersistentVolumeClaim)
	if !ok || pvc.Namespace == "" || pvc.Labels[workspacePVCPartOfLabel] != workspacePVCPartOfValue {
		return nil
	}
	workspaceName := pvc.Labels[workspacePVCWorkspaceLabel]
	workspaceUID := pvc.Annotations[clusterv1alpha1.WorkspaceUIDAnnotation]
	if workspaceName == "" || workspaceUID == "" {
		return nil
	}
	workspaceIdentity := &clusterv1alpha1.T4Workspace{ObjectMeta: metav1.ObjectMeta{Name: workspaceName, UID: types.UID(workspaceUID)}}
	if pvc.Name != WorkspacePVCName(workspaceIdentity) {
		return nil
	}
	return []ctrl.Request{{NamespacedName: types.NamespacedName{Namespace: pvc.Namespace, Name: workspaceName}}}
}

func indexHostByStorageClass(object client.Object) []string {
	host, ok := object.(*clusterv1alpha1.T4ClusterHost)
	if !ok || host.Spec.StorageClassName == "" {
		return nil
	}
	return []string{host.Spec.StorageClassName}
}

func indexWorkspaceByHostRef(object client.Object) []string {
	workspace, ok := object.(*clusterv1alpha1.T4Workspace)
	if !ok || workspace.Spec.HostRef == "" {
		return nil
	}
	return []string{workspace.Spec.HostRef}
}

func (r *WorkspaceReconciler) workspaceRequestsForStorageClass(ctx context.Context, object client.Object) []ctrl.Request {
	storageClass, ok := object.(*storagev1.StorageClass)
	if !ok || storageClass.Name == "" {
		return nil
	}
	var hosts clusterv1alpha1.T4ClusterHostList
	if err := r.List(ctx, &hosts, client.MatchingFields{hostStorageClassIndexField: storageClass.Name}); err != nil {
		ctrl.LoggerFrom(ctx).Error(err, "unable to map StorageClass to cluster hosts", "storageClass", storageClass.Name)
		return nil
	}
	requests := make([]ctrl.Request, 0)
	for i := range hosts.Items {
		host := &hosts.Items[i]
		var workspaces clusterv1alpha1.T4WorkspaceList
		if err := r.List(ctx, &workspaces, client.InNamespace(host.Namespace), client.MatchingFields{workspaceHostRefIndexField: host.Name}); err != nil {
			ctrl.LoggerFrom(ctx).Error(err, "unable to map cluster host to workspaces", "clusterHost", client.ObjectKeyFromObject(host))
			continue
		}
		for j := range workspaces.Items {
			requests = append(requests, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(&workspaces.Items[j])})
		}
	}
	return requests
}

func (r *WorkspaceReconciler) workspaceRequestsForHost(ctx context.Context, object client.Object) []ctrl.Request {
	host, ok := object.(*clusterv1alpha1.T4ClusterHost)
	if !ok || host.Name == "" || host.Namespace == "" {
		return nil
	}
	var workspaces clusterv1alpha1.T4WorkspaceList
	if err := r.List(ctx, &workspaces, client.InNamespace(host.Namespace), client.MatchingFields{workspaceHostRefIndexField: host.Name}); err != nil {
		ctrl.LoggerFrom(ctx).Error(err, "unable to map cluster host to workspaces", "clusterHost", client.ObjectKeyFromObject(host))
		return nil
	}
	requests := make([]ctrl.Request, 0, len(workspaces.Items))
	for i := range workspaces.Items {
		requests = append(requests, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(&workspaces.Items[i])})
	}
	return requests
}

func (r *WorkspaceReconciler) SetupWithManager(manager ctrl.Manager) error {
	if err := manager.GetFieldIndexer().IndexField(context.Background(), &clusterv1alpha1.T4ClusterHost{}, hostStorageClassIndexField, indexHostByStorageClass); err != nil {
		return fmt.Errorf("index T4ClusterHost by StorageClass: %w", err)
	}
	if err := manager.GetFieldIndexer().IndexField(context.Background(), &clusterv1alpha1.T4Workspace{}, workspaceHostRefIndexField, indexWorkspaceByHostRef); err != nil {
		return fmt.Errorf("index T4Workspace by host reference: %w", err)
	}
	return ctrl.NewControllerManagedBy(manager).
		For(&clusterv1alpha1.T4Workspace{}).
		Watches(&clusterv1alpha1.T4ClusterHost{}, handler.EnqueueRequestsFromMapFunc(r.workspaceRequestsForHost)).
		Watches(&corev1.PersistentVolumeClaim{}, handler.EnqueueRequestsFromMapFunc(workspaceRequestsForPVC)).
		Watches(&storagev1.StorageClass{}, handler.EnqueueRequestsFromMapFunc(r.workspaceRequestsForStorageClass)).
		Complete(r)
}
