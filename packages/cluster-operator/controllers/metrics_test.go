package controllers

import (
	"context"
	"errors"
	"maps"
	"reflect"
	"sync"
	"testing"
	"time"

	coordinationv1 "k8s.io/api/coordination/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	storagev1 "k8s.io/api/storage/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	controllermetrics "sigs.k8s.io/controller-runtime/pkg/metrics"

	clusterv1alpha1 "github.com/wolfiesch/omperator/packages/cluster-operator/api/v1alpha1"
)

func TestReconcilersEmitExactDurationAndErrorMetrics(t *testing.T) {
	scheme := metricsTestScheme(t)
	missingKey := client.ObjectKey{Namespace: "team", Name: "missing"}
	newClient := func() client.Client { return fake.NewClientBuilder().WithScheme(scheme).Build() }
	forcedError := errors.New("forced get failure")
	tests := []struct {
		resource  string
		reconcile func(client.Client) error
	}{
		{metricKindClusterHost, func(c client.Client) error { _, err := (&ClusterHostReconciler{Client: c, Scheme: scheme}).Reconcile(t.Context(), requestFor(missingKey)); return err }},
		{metricKindWorkspace, func(c client.Client) error { _, err := (&WorkspaceReconciler{Client: c, Scheme: scheme}).Reconcile(t.Context(), requestFor(missingKey)); return err }},
		{metricKindSession, func(c client.Client) error { _, err := (&SessionReconciler{Client: c, Scheme: scheme}).Reconcile(t.Context(), requestFor(missingKey)); return err }},
	}
	for _, test := range tests {
		t.Run(test.resource, func(t *testing.T) {
			successLabels := map[string]string{"resource": test.resource, "result": "success"}
			errorLabels := map[string]string{"resource": test.resource, "result": "error"}
			beforeSuccess, _ := gatheredMetricValue(t, "omperator_reconcile_duration_seconds", successLabels)
			beforeError, _ := gatheredMetricValue(t, "omperator_reconcile_duration_seconds", errorLabels)
			beforeErrors, _ := gatheredMetricValue(t, "omperator_reconcile_errors_total", map[string]string{"resource": test.resource, "error_class": "internal"})
			if err := test.reconcile(newClient()); err != nil { t.Fatalf("not-found reconcile returned an error: %v", err) }
			if err := test.reconcile(&getErrorClient{Client: newClient(), err: forcedError}); !errors.Is(err, forcedError) { t.Fatalf("error reconcile = %v, want %v", err, forcedError) }
			afterSuccess, ok := gatheredMetricValue(t, "omperator_reconcile_duration_seconds", successLabels)
			if !ok || afterSuccess-beforeSuccess != 1 { t.Fatalf("success histogram count delta = %v, want 1", afterSuccess-beforeSuccess) }
			afterError, ok := gatheredMetricValue(t, "omperator_reconcile_duration_seconds", errorLabels)
			if !ok || afterError-beforeError != 1 { t.Fatalf("error histogram count delta = %v, want 1", afterError-beforeError) }
			afterErrors, ok := gatheredMetricValue(t, "omperator_reconcile_errors_total", map[string]string{"resource": test.resource, "error_class": "internal"})
			if !ok || afterErrors-beforeErrors != 1 { t.Fatalf("error counter delta = %v, want 1", afterErrors-beforeErrors) }
		})
	}
}

func TestRuntimeReadyGaugeAggregatesWithoutResourceLabels(t *testing.T) {
	first := client.ObjectKey{Namespace: "team-a", Name: "runtime-a"}
	second := client.ObjectKey{Namespace: "team-b", Name: "runtime-b"}
	runtimeReadyStore.project(first, true, true)
	runtimeReadyStore.project(second, false, true)
	assertMetricValue(t, "omperator_runtime_ready", nil, 1)
	runtimeReadyStore.project(second, true, true)
	assertMetricValue(t, "omperator_runtime_ready", nil, 2)
	runtimeReadyStore.project(first, false, false)
	runtimeReadyStore.project(second, false, false)
	assertMetricValue(t, "omperator_runtime_ready", nil, 0)
}

func TestDrainMetricsCoverFlushFailureAndTimeout(t *testing.T) {
	errorLabels := map[string]string{"result": "error"}
	timeoutLabels := map[string]string{"result": "timeout"}
	beforeError, _ := gatheredMetricValue(t, "omperator_drain_total", errorLabels)
	beforeTimeout, _ := gatheredMetricValue(t, "omperator_drain_total", timeoutLabels)
	observeDrain(errors.New("durable flush failed"))
	observeDrain(context.DeadlineExceeded)
	afterError, ok := gatheredMetricValue(t, "omperator_drain_total", errorLabels)
	if !ok || afterError-beforeError != 1 { t.Fatalf("drain error delta = %v, want 1", afterError-beforeError) }
	afterTimeout, ok := gatheredMetricValue(t, "omperator_drain_total", timeoutLabels)
	if !ok || afterTimeout-beforeTimeout != 1 { t.Fatalf("drain timeout delta = %v, want 1", afterTimeout-beforeTimeout) }
}

func TestExactRuntimeAndStorageDurationProducersObserveOutcomes(t *testing.T) {
	beforeStart, _ := gatheredMetricValue(t, "omperator_runtime_start_duration_seconds", map[string]string{"result": "error"})
	beforeFence, _ := gatheredMetricValue(t, "omperator_runtime_fence_duration_seconds", map[string]string{"result": "fenced"})
	observeRuntimeStart(errors.New("runtime start failed"), false, time.Now())
	observeRuntimeFence(nil, true, time.Now())
	afterStart, ok := gatheredMetricValue(t, "omperator_runtime_start_duration_seconds", map[string]string{"result": "error"})
	if !ok || afterStart-beforeStart != 1 { t.Fatalf("runtime start error count delta = %v, want 1", afterStart-beforeStart) }
	afterFence, ok := gatheredMetricValue(t, "omperator_runtime_fence_duration_seconds", map[string]string{"result": "fenced"})
	if !ok || afterFence-beforeFence != 1 { t.Fatalf("runtime fence count delta = %v, want 1", afterFence-beforeFence) }

	scheme := metricsTestScheme(t)
	host := &clusterv1alpha1.T4ClusterHost{
		ObjectMeta: metav1.ObjectMeta{Name: "host-storage-missing", Namespace: "team"},
		Spec: clusterv1alpha1.T4ClusterHostSpec{StorageClassName: "missing-rwx"},
	}
	store := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4ClusterHost{}).WithObjects(host).Build()
	beforeStorage, _ := gatheredMetricValue(t, "omperator_storage_operation_duration_seconds", map[string]string{"operation": "probe", "result": "error"})
	if _, err := (&ClusterHostReconciler{Client: store, Scheme: scheme}).Reconcile(t.Context(), ctrl.Request{NamespacedName: client.ObjectKeyFromObject(host)}); err != nil {
		t.Fatal(err)
	}
	afterStorage, ok := gatheredMetricValue(t, "omperator_storage_operation_duration_seconds", map[string]string{"operation": "probe", "result": "error"})
	if !ok || afterStorage-beforeStorage != 1 { t.Fatalf("storage probe error count delta = %v, want 1", afterStorage-beforeStorage) }
}

func TestExactDurationFamiliesRejectNoObservationsAndRegisterOnce(t *testing.T) {
	observeReconcile(metricKindSession, client.ObjectKey{Namespace: "team", Name: "runtime"}, "Ready", true, nil, time.Now())
	var callers sync.WaitGroup
	for range 32 {
		callers.Add(1)
		go func() { defer callers.Done(); registerControllerMetrics() }()
	}
	callers.Wait()
	families, err := controllermetrics.Registry.Gather()
	if err != nil { t.Fatal(err) }
	counts := map[string]int{}
	for _, family := range families { counts[family.GetName()]++ }
	for _, name := range []string{
		"omperator_reconcile_duration_seconds", "omperator_reconcile_errors_total",
		"omperator_runtime_start_duration_seconds", "omperator_runtime_fence_duration_seconds",
		"omperator_storage_operation_duration_seconds", "omperator_runtime_ready", "omperator_drain_total",
	} {
		if counts[name] != 1 { t.Fatalf("registered metric family %q count = %d, want 1", name, counts[name]) }
	}
	assertMetricLabelsAreBounded(t)
}

type getErrorClient struct { client.Client; err error }
func (c *getErrorClient) Get(context.Context, client.ObjectKey, client.Object, ...client.GetOption) error { return c.err }

func metricsTestScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	scheme := runtime.NewScheme()
	for _, add := range []func(*runtime.Scheme) error{corev1.AddToScheme, coordinationv1.AddToScheme, rbacv1.AddToScheme, storagev1.AddToScheme, clusterv1alpha1.AddToScheme} {
		if err := add(scheme); err != nil { t.Fatal(err) }
	}
	return scheme
}
func requestFor(key client.ObjectKey) ctrl.Request { return ctrl.Request{NamespacedName: key} }

func assertMetricValue(t *testing.T, name string, labels map[string]string, want float64) {
	t.Helper()
	got, ok := gatheredMetricValue(t, name, labels)
	if !ok || got != want { t.Fatalf("%s%v = %v (present %t), want %v", name, labels, got, ok, want) }
}
func gatheredMetricValue(t *testing.T, name string, labels map[string]string) (float64, bool) {
	t.Helper()
	labels = maps.Clone(labels)
	if labels == nil { labels = map[string]string{} }
	labels["component"] = "cluster-operator"
	families, err := controllermetrics.Registry.Gather()
	if err != nil { t.Fatal(err) }
	for _, family := range families {
		if family.GetName() != name { continue }
		for _, metric := range family.GetMetric() {
			metricLabels := make(map[string]string, len(metric.GetLabel()))
			for _, pair := range metric.GetLabel() { metricLabels[pair.GetName()] = pair.GetValue() }
			if !reflect.DeepEqual(metricLabels, labels) { continue }
			if metric.Counter != nil { return metric.GetCounter().GetValue(), true }
			if metric.Gauge != nil { return metric.GetGauge().GetValue(), true }
			if metric.Histogram != nil { return float64(metric.GetHistogram().GetSampleCount()), true }
		}
	}
	return 0, false
}
func assertMetricLabelsAreBounded(t *testing.T) {
	t.Helper()
	families, err := controllermetrics.Registry.Gather()
	if err != nil { t.Fatal(err) }
	allowedResources := map[string]bool{metricKindClusterHost: true, metricKindWorkspace: true, metricKindSession: true}
	for _, family := range families {
		if family.GetName() != "omperator_reconcile_duration_seconds" && family.GetName() != "omperator_reconcile_errors_total" { continue }
		for _, metric := range family.GetMetric() {
			labels := map[string]string{}
			for _, pair := range metric.GetLabel() { labels[pair.GetName()] = pair.GetValue() }
			if labels["component"] != "cluster-operator" || !allowedResources[labels["resource"]] { t.Fatalf("unbounded metric labels: %v", labels) }
			if family.GetName() == "omperator_reconcile_duration_seconds" && labels["result"] != "success" && labels["result"] != "error" { t.Fatalf("unbounded reconcile result: %v", labels) }
			if family.GetName() == "omperator_reconcile_errors_total" && labels["error_class"] != "internal" { t.Fatalf("unbounded error class: %v", labels) }
		}
	}
}
