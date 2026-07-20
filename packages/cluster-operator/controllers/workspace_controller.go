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
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	clusterv1alpha1 "github.com/LycaonLLC/t4-code/packages/cluster-operator/api/v1alpha1"
)

type WorkspaceReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

func (r *WorkspaceReconciler) Reconcile(ctx context.Context, request ctrl.Request) (ctrl.Result, error) {
	var workspace clusterv1alpha1.T4Workspace
	if err := r.Get(ctx, request.NamespacedName, &workspace); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
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
	var pvc corev1.PersistentVolumeClaim
	err := r.Get(ctx, types.NamespacedName{Namespace: workspace.Namespace, Name: pvcName}, &pvc)
	if apierrors.IsNotFound(err) {
		volumeMode := corev1.PersistentVolumeFilesystem
		pvc = corev1.PersistentVolumeClaim{
			ObjectMeta: metav1.ObjectMeta{
				Name: pvcName, Namespace: workspace.Namespace,
				Labels: map[string]string{
					"app.kubernetes.io/part-of": "t4-cluster",
					"cluster.t4.dev/workspace":  workspace.Name,
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
		if err := r.Create(ctx, &pvc); err != nil && !apierrors.IsAlreadyExists(err) {
			return ctrl.Result{}, err
		}
	} else if err != nil {
		return ctrl.Result{}, err
	} else if !workspaceOwnsPVC(&workspace, &pvc) {
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateWorkspaceFailure(ctx, &workspace, "StorageReady", "PVCOwnershipConflict", "deterministic workspace PVC does not belong to this workspace")
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
	meta.SetStatusCondition(&workspace.Status.Conditions, condition("StorageReady", metav1.ConditionTrue, ReasonStorageReady, "RWX StorageClass and workspace PVC are accepted", workspace.Generation))
	switch pvc.Status.Phase {
	case corev1.ClaimBound:
		if !pvcHasRWX(&pvc) {
			workspace.Status.Phase = clusterv1alpha1.InfrastructureFailed
			meta.SetStatusCondition(&workspace.Status.Conditions, condition("Ready", metav1.ConditionFalse, "PVCNotRWX", "bound workspace PVC does not request ReadWriteMany", workspace.Generation))
		} else {
			workspace.Status.Phase = clusterv1alpha1.InfrastructureReady
			meta.SetStatusCondition(&workspace.Status.Conditions, condition("Ready", metav1.ConditionTrue, "PVCBound", "workspace PVC is bound with ReadWriteMany access", workspace.Generation))
		}
	case corev1.ClaimLost:
		workspace.Status.Phase = clusterv1alpha1.InfrastructureFailed
		meta.SetStatusCondition(&workspace.Status.Conditions, condition("Ready", metav1.ConditionFalse, "PVCLost", "workspace PVC lost its volume", workspace.Generation))
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
	if err := r.List(ctx, &sessions, client.InNamespace(workspace.Namespace)); err != nil {
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
	err := r.Get(ctx, pvcKey, &pvc)
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
			if err := r.Delete(ctx, &pvc); err != nil && !apierrors.IsNotFound(err) {
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
	workspace.Status.Phase = clusterv1alpha1.InfrastructureFailed
	meta.SetStatusCondition(&workspace.Status.Conditions, condition(conditionType, metav1.ConditionFalse, reason, message, workspace.Generation))
	if reflect.DeepEqual(original, workspace.Status) {
		return nil
	}
	return r.Status().Update(ctx, workspace)
}

func (r *WorkspaceReconciler) SetupWithManager(manager ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(manager).
		For(&clusterv1alpha1.T4Workspace{}).
		Owns(&corev1.PersistentVolumeClaim{}).
		Complete(r)
}
