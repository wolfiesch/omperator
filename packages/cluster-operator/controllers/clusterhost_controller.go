package controllers

import (
	"context"
	"reflect"
	"time"

	storagev1 "k8s.io/api/storage/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	meta "k8s.io/apimachinery/pkg/api/meta"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"

	clusterv1alpha1 "github.com/wolfiesch/omperator/packages/cluster-operator/api/v1alpha1"
)

type ClusterHostReconciler struct {
	client.Client
	Scheme *runtime.Scheme
}

func (r *ClusterHostReconciler) Reconcile(ctx context.Context, request ctrl.Request) (result ctrl.Result, err error) {
	startedAt := time.Now()
	var host clusterv1alpha1.T4ClusterHost
	found := false
	defer func() {
		observeReconcile(metricKindClusterHost, request.NamespacedName, "", conditionObjectPresent(&host, found, err), err, startedAt)
		if found {
			storageReady := meta.FindStatusCondition(host.Status.Conditions, "StorageReady")
			observeStorageOperation("probe", err, storageReady != nil && storageReady.Status == metav1.ConditionFalse, startedAt)
		}
	}()
	if err := r.Get(ctx, request.NamespacedName, &host); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	found = true
	original := host.Status
	if host.Status.Conditions != nil {
		original.Conditions = append([]metav1.Condition(nil), host.Status.Conditions...)
	}
	host.Status.ObservedGeneration = host.Generation

	var storageClass storagev1.StorageClass
	workspaceStorageReady := true
	if err := r.Get(ctx, types.NamespacedName{Name: host.Spec.StorageClassName}, &storageClass); err != nil {
		if !apierrors.IsNotFound(err) {
			return ctrl.Result{}, err
		}
		workspaceStorageReady = false
	} else if !storageClassAllowsRWX(storageClass.Annotations) {
		workspaceStorageReady = false
	}

	runtimeStorageReady := host.Spec.RuntimeStateStorageProfile != nil
	if profile := host.Spec.RuntimeStateStorageProfile; profile != nil {
		var runtimeStorageClass storagev1.StorageClass
		if err := r.Get(ctx, types.NamespacedName{Name: profile.StorageClassName}, &runtimeStorageClass); err != nil {
			if !apierrors.IsNotFound(err) {
				return ctrl.Result{}, err
			}
			runtimeStorageReady = false
		}
	}

	if workspaceStorageReady && runtimeStorageReady {
		observed, observeErr := ObserveStorageCapabilities(ctx, r.Client, &host, metav1.Now())
		if observeErr != nil {
			return ctrl.Result{}, observeErr
		}
		host.Status.StorageCapabilities = observed
		if gateErr := StorageCapabilitiesPermitRuntime(&host); gateErr != nil {
			runtimeStorageReady = false
		}
	}

	storageReady := workspaceStorageReady && runtimeStorageReady
	switch {
	case !workspaceStorageReady && storageClass.Name == "":
		meta.SetStatusCondition(&host.Status.Conditions, condition("StorageReady", metav1.ConditionFalse, ReasonStorageClassNotFound, "selected workspace StorageClass does not exist", host.Generation))
	case !workspaceStorageReady:
		meta.SetStatusCondition(&host.Status.Conditions, condition("StorageReady", metav1.ConditionFalse, ReasonStorageClassNotRWX, "selected workspace StorageClass is not administrator-declared ReadWriteMany", host.Generation))
	case host.Spec.RuntimeStateStorageProfile == nil:
		meta.SetStatusCondition(&host.Status.Conditions, condition("StorageReady", metav1.ConditionFalse, "RuntimeStateStorageRequired", "separate runtime-state storage is required", host.Generation))
	case !runtimeStorageReady:
		meta.SetStatusCondition(&host.Status.Conditions, condition("StorageReady", metav1.ConditionFalse, "StorageConformanceRequired", "selected storage classes have not passed bounded remount and reattach conformance", host.Generation))
	default:
		meta.SetStatusCondition(&host.Status.Conditions, condition("StorageReady", metav1.ConditionTrue, ReasonStorageReady, "workspace and runtime-state storage capabilities are observed and supported", host.Generation))
	}

	ciReady := true
	ciReason := "NotConfigured"
	ciMessage := "CI provider is optional and not configured"
	if host.Spec.CIProvider != nil {
		hasSecret := host.Spec.CIProvider.SecretRef != nil && host.Spec.CIProvider.SecretRef.Name != ""
		hasProjectedIdentity := host.Spec.CIProvider.ServiceAccountAudience != ""
		ciReady = host.Spec.CIProvider.ConfigMapRef.Name != "" && hasSecret != hasProjectedIdentity
		if ciReady {
			ciReason, ciMessage = "ReferencesConfigured", "CI provider configuration and one server-side credential source are configured"
		} else {
			ciReason, ciMessage = "ReferencesIncomplete", "CI provider requires a ConfigMap and exactly one Secret or projected ServiceAccount identity"
		}
	}
	status := metav1.ConditionFalse
	if ciReady {
		status = metav1.ConditionTrue
	}
	meta.SetStatusCondition(&host.Status.Conditions, condition("CIReady", status, ciReason, ciMessage, host.Generation))

	available := storageReady && len(host.Spec.RuntimeProfiles) > 0
	if available {
		meta.SetStatusCondition(&host.Status.Conditions, condition("Available", metav1.ConditionTrue, "ConfigurationAccepted", "cluster host infrastructure configuration is available", host.Generation))
	} else {
		meta.SetStatusCondition(&host.Status.Conditions, condition("Available", metav1.ConditionFalse, "ConfigurationNotReady", "cluster host infrastructure configuration is not ready", host.Generation))
	}
	if !reflect.DeepEqual(original, host.Status) {
		if err := r.Status().Update(ctx, &host); err != nil {
			return ctrl.Result{}, err
		}
	}
	return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
}

func (r *ClusterHostReconciler) SetupWithManager(manager ctrl.Manager) error {
	return ctrl.NewControllerManagedBy(manager).For(&clusterv1alpha1.T4ClusterHost{}).Complete(r)
}
