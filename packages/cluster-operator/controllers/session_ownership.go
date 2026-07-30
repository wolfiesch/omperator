package controllers

import (
	"context"
	"fmt"
	"reflect"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	meta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"

	clusterv1alpha1 "github.com/wolfiesch/omperator/packages/cluster-operator/api/v1alpha1"
)

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
	var ownershipConflict client.Object
	reader := r.APIReader
	if reader == nil {
		reader = r.Client
	}
	for _, object := range objects {
		err := reader.Get(ctx, client.ObjectKeyFromObject(object), object)
		if apierrors.IsNotFound(err) {
			continue
		}
		if err != nil {
			return ctrl.Result{}, err
		}
		if !sessionExclusivelyOwnsResource(object, session) {
			if ownershipConflict == nil {
				ownershipConflict = object
			}
			continue
		}
		existing = append(existing, object)
	}
	for _, object := range existing {
		if object.GetDeletionTimestamp().IsZero() {
			if err := deleteWithPreconditions(ctx, r.Client, object); err != nil && !apierrors.IsNotFound(err) {
				return ctrl.Result{}, err
			}
		}
	}
	if ownershipConflict != nil {
		before := session.Status
		if session.Status.Conditions != nil {
			before.Conditions = append([]metav1.Condition(nil), session.Status.Conditions...)
		}
		meta.SetStatusCondition(&session.Status.Conditions, condition("Available", metav1.ConditionFalse, "CleanupOwnershipConflict", fmt.Sprintf("deterministic %T is not controlled by this session", ownershipConflict), session.Generation))
		if !reflect.DeepEqual(before, session.Status) {
			if err := r.Status().Update(ctx, session); err != nil {
				return ctrl.Result{}, err
			}
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
	}
	if len(existing) > 0 {
		return ctrl.Result{RequeueAfter: time.Second}, nil
	}
	controllerutil.RemoveFinalizer(session, clusterv1alpha1.SessionFinalizer)
	return ctrl.Result{}, r.Update(ctx, session)
}

func (r *SessionReconciler) deleteOwnedSessionResources(ctx context.Context, session *clusterv1alpha1.T4Session) error {
	reader := r.APIReader
	if reader == nil {
		reader = r.Client
	}
	return r.deleteOwnedSessionResourcesWithFailure(ctx, reader, session, true, false, false, "ResourceOwnershipConflict", "one or more deterministic session resources have an unexpected owner")
}

func (r *SessionReconciler) deleteOwnedSessionResourcesAfterVerifiedDependencies(ctx context.Context, session *clusterv1alpha1.T4Session, reason, message string) error {
	reader := r.APIReader
	if reader == nil {
		reader = r.Client
	}
	return r.deleteOwnedSessionResourcesWithFailure(ctx, reader, session, false, true, true, reason, message)
}

func (r *SessionReconciler) deleteOwnedSessionResourcesWithFailure(ctx context.Context, reader client.Reader, session *clusterv1alpha1.T4Session, deleteWithoutConflict, hostReady, workspaceReady bool, reason, message string) error {
	objects := []client.Object{
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: SessionPodName(session), Namespace: session.Namespace}},
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: SessionServiceName(session), Namespace: session.Namespace}},
	}
	owned := make([]client.Object, 0, len(objects))
	ownershipConflict := false
	for _, object := range objects {
		if err := reader.Get(ctx, client.ObjectKeyFromObject(object), object); err != nil {
			if err := client.IgnoreNotFound(err); err != nil {
				return err
			}
			continue
		}
		if !sessionExclusivelyOwnsResource(object, session) {
			ownershipConflict = true
			continue
		}
		owned = append(owned, object)
	}
	if ownershipConflict || deleteWithoutConflict {
		for _, object := range owned {
			if err := deleteWithPreconditions(ctx, r.Client, object); err != nil && !apierrors.IsNotFound(err) {
				return err
			}
		}
	}
	if ownershipConflict {
		if err := r.updateSessionFailure(ctx, session, hostReady, workspaceReady, "Available", reason, message); err != nil {
			return err
		}
		return errSessionResourceOwnershipConflict
	}
	return nil
}

func deleteWithPreconditions(ctx context.Context, writer client.Client, object client.Object) error {
	preconditions := metav1.Preconditions{}
	if uid := object.GetUID(); uid != "" {
		preconditions.UID = &uid
	}
	if resourceVersion := object.GetResourceVersion(); resourceVersion != "" {
		preconditions.ResourceVersion = &resourceVersion
	}
	options := &client.DeleteOptions{}
	if preconditions.UID != nil || preconditions.ResourceVersion != nil {
		options.Preconditions = &preconditions
	}
	return writer.Delete(ctx, object, options)
}

func (r *SessionReconciler) updateSessionFailure(ctx context.Context, session *clusterv1alpha1.T4Session, hostReady, workspaceReady bool, conditionType, reason, message string) error {
	original := session.Status
	if session.Status.Conditions != nil {
		original.Conditions = append([]metav1.Condition(nil), session.Status.Conditions...)
	}
	if conditionType == "HostReady" {
		meta.SetStatusCondition(&session.Status.Conditions, condition("HostReady", metav1.ConditionFalse, reason, message, session.Generation))
	} else if hostReady {
		meta.SetStatusCondition(&session.Status.Conditions, condition("HostReady", metav1.ConditionTrue, "HostResolved", "referenced T4ClusterHost is available", session.Generation))
	} else {
		meta.SetStatusCondition(&session.Status.Conditions, condition("HostReady", metav1.ConditionUnknown, "NotEvaluated", "host dependency was not evaluated", session.Generation))
	}
	if conditionType == "WorkspaceReady" {
		meta.SetStatusCondition(&session.Status.Conditions, condition("WorkspaceReady", metav1.ConditionFalse, reason, message, session.Generation))
	} else if workspaceReady {
		meta.SetStatusCondition(&session.Status.Conditions, condition("WorkspaceReady", metav1.ConditionTrue, "PVCBoundRWX", "workspace PVC is Bound and ReadWriteMany", session.Generation))
	} else {
		meta.SetStatusCondition(&session.Status.Conditions, condition("WorkspaceReady", metav1.ConditionUnknown, "NotEvaluated", "workspace dependency was not evaluated", session.Generation))
	}
	if conditionType == "RuntimeConfigured" {
		meta.SetStatusCondition(&session.Status.Conditions, condition("RuntimeConfigured", metav1.ConditionFalse, reason, message, session.Generation))
	} else if workspaceReady {
		meta.SetStatusCondition(&session.Status.Conditions, condition("RuntimeConfigured", metav1.ConditionTrue, "OMPReferencesReady", "administrator-owned OMP runtime references are configured", session.Generation))
	} else {
		meta.SetStatusCondition(&session.Status.Conditions, condition("RuntimeConfigured", metav1.ConditionUnknown, "NotEvaluated", "runtime configuration was not evaluated", session.Generation))
	}
	session.Status.ObservedGeneration = session.Generation
	session.Status.PodName = ""
	session.Status.ServiceName = ""
	session.Status.Phase = clusterv1alpha1.InfrastructureFailed
	meta.SetStatusCondition(&session.Status.Conditions, condition("Available", metav1.ConditionFalse, reason, message, session.Generation))
	if reflect.DeepEqual(original, session.Status) {
		return nil
	}
	return r.Status().Update(ctx, session)
}

func sessionExclusivelyOwnsResource(object metav1.Object, session *clusterv1alpha1.T4Session) bool {
	controller := metav1.GetControllerOf(object)
	if controller == nil || controller.APIVersion != clusterv1alpha1.GroupVersion.String() || controller.Kind != "T4Session" || controller.Name != session.Name || controller.UID != session.UID {
		return false
	}
	for _, reference := range object.GetOwnerReferences() {
		if reference.APIVersion != clusterv1alpha1.GroupVersion.String() || reference.Kind != "T4Session" || reference.Name != session.Name || reference.UID != session.UID {
			return false
		}
	}
	return true
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
