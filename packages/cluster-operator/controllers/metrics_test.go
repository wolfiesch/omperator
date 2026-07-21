package controllers

import (
	"context"
	"errors"
	"reflect"
	"sort"
	"sync"
	"testing"

	corev1 "k8s.io/api/core/v1"
	storagev1 "k8s.io/api/storage/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"
	controllermetrics "sigs.k8s.io/controller-runtime/pkg/metrics"

	clusterv1alpha1 "github.com/LycaonLLC/t4-code/packages/cluster-operator/api/v1alpha1"
)

func TestReconcilersEmitBoundedCompletionMetrics(t *testing.T) {
	scheme := metricsTestScheme(t)
	missingKey := client.ObjectKey{Namespace: "team", Name: "missing"}
	newClient := func() client.Client {
		return fake.NewClientBuilder().WithScheme(scheme).Build()
	}
	forcedError := errors.New("forced get failure")

	tests := []struct {
		kind      string
		reconcile func(client.Client) error
	}{
		{
			kind: metricKindClusterHost,
			reconcile: func(c client.Client) error {
				_, err := (&ClusterHostReconciler{Client: c, Scheme: scheme}).Reconcile(t.Context(), requestFor(missingKey))
				return err
			},
		},
		{
			kind: metricKindWorkspace,
			reconcile: func(c client.Client) error {
				_, err := (&WorkspaceReconciler{Client: c, Scheme: scheme}).Reconcile(t.Context(), requestFor(missingKey))
				return err
			},
		},
		{
			kind: metricKindSession,
			reconcile: func(c client.Client) error {
				_, err := (&SessionReconciler{Client: c, Scheme: scheme}).Reconcile(t.Context(), requestFor(missingKey))
				return err
			},
		},
	}

	for _, test := range tests {
		t.Run(test.kind, func(t *testing.T) {
			successLabels := map[string]string{"kind": test.kind, "result": "success"}
			errorLabels := map[string]string{"kind": test.kind, "result": "error"}
			beforeSuccess, _ := gatheredMetricValue(t, "t4_cluster_reconcile_total", successLabels)
			beforeError, _ := gatheredMetricValue(t, "t4_cluster_reconcile_total", errorLabels)

			if err := test.reconcile(newClient()); err != nil {
				t.Fatalf("not-found reconcile returned an error: %v", err)
			}
			if err := test.reconcile(&getErrorClient{Client: newClient(), err: forcedError}); !errors.Is(err, forcedError) {
				t.Fatalf("error reconcile = %v, want %v", err, forcedError)
			}

			afterSuccess, ok := gatheredMetricValue(t, "t4_cluster_reconcile_total", successLabels)
			if !ok || afterSuccess-beforeSuccess != 1 {
				t.Fatalf("success counter delta = %v, want 1", afterSuccess-beforeSuccess)
			}
			afterError, ok := gatheredMetricValue(t, "t4_cluster_reconcile_total", errorLabels)
			if !ok || afterError-beforeError != 1 {
				t.Fatalf("error counter delta = %v, want 1", afterError-beforeError)
			}
		})
	}
}

func TestConditionMetricProjectsKnownTransitionsWithBoundedLabels(t *testing.T) {
	scheme := metricsTestScheme(t)
	host := &clusterv1alpha1.T4ClusterHost{
		ObjectMeta: metav1.ObjectMeta{Name: "host-a", Namespace: "team", Generation: 1},
		Spec: clusterv1alpha1.T4ClusterHostSpec{
			StorageClassName: "portable-rwx",
			RuntimeProfiles:  []string{"default"},
		},
		Status: clusterv1alpha1.T4ClusterHostStatus{Conditions: []metav1.Condition{{
			Type: "owner-team-a-secret-token", Status: metav1.ConditionTrue, Reason: "Untrusted", Message: "must not become a metric label",
		}}},
	}
	hostB := host.DeepCopy()
	hostB.Name = "host-b"
	hostB.Status.Conditions = nil
	storageClass := &storagev1.StorageClass{
		ObjectMeta: metav1.ObjectMeta{
			Name:        "portable-rwx",
			Annotations: map[string]string{clusterv1alpha1.RWXStorageClassAnnotation: string(corev1.ReadWriteMany)},
		},
		Provisioner: "example.invalid/csi",
	}
	c := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4ClusterHost{}).WithObjects(host, hostB, storageClass).Build()
	r := &ClusterHostReconciler{Client: c, Scheme: scheme}
	if _, err := r.Reconcile(t.Context(), requestFor(client.ObjectKeyFromObject(host))); err != nil {
		t.Fatal(err)
	}
	assertMetricValue(t, "t4_cluster_condition", map[string]string{"kind": metricKindClusterHost, "condition": "StorageReady", "status": "true"}, 1)
	assertMetricValue(t, "t4_cluster_condition", map[string]string{"kind": metricKindClusterHost, "condition": "StorageReady", "status": "false"}, 0)

	var updatedStorageClass storagev1.StorageClass
	if err := c.Get(t.Context(), client.ObjectKeyFromObject(storageClass), &updatedStorageClass); err != nil {
		t.Fatal(err)
	}
	updatedStorageClass.Annotations = nil
	if err := c.Update(t.Context(), &updatedStorageClass); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Reconcile(t.Context(), requestFor(client.ObjectKeyFromObject(host))); err != nil {
		t.Fatal(err)
	}
	assertMetricValue(t, "t4_cluster_condition", map[string]string{"kind": metricKindClusterHost, "condition": "StorageReady", "status": "true"}, 0)
	assertMetricValue(t, "t4_cluster_condition", map[string]string{"kind": metricKindClusterHost, "condition": "StorageReady", "status": "false"}, 1)
	updatedStorageClass.Annotations = map[string]string{clusterv1alpha1.RWXStorageClassAnnotation: string(corev1.ReadWriteMany)}
	if err := c.Update(t.Context(), &updatedStorageClass); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Reconcile(t.Context(), requestFor(client.ObjectKeyFromObject(hostB))); err != nil {
		t.Fatal(err)
	}
	assertMetricValue(t, "t4_cluster_condition", map[string]string{"kind": metricKindClusterHost, "condition": "StorageReady", "status": "true"}, 1)
	assertMetricValue(t, "t4_cluster_condition", map[string]string{"kind": metricKindClusterHost, "condition": "StorageReady", "status": "false"}, 1)

	var deletingHost clusterv1alpha1.T4ClusterHost
	if err := c.Get(t.Context(), client.ObjectKeyFromObject(host), &deletingHost); err != nil {
		t.Fatal(err)
	}
	if err := c.Delete(t.Context(), &deletingHost); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Reconcile(t.Context(), requestFor(client.ObjectKeyFromObject(host))); err != nil {
		t.Fatal(err)
	}
	assertMetricValue(t, "t4_cluster_condition", map[string]string{"kind": metricKindClusterHost, "condition": "StorageReady", "status": "true"}, 1)
	assertMetricValue(t, "t4_cluster_condition", map[string]string{"kind": metricKindClusterHost, "condition": "StorageReady", "status": "false"}, 0)

	if err := c.Get(t.Context(), client.ObjectKeyFromObject(hostB), &deletingHost); err != nil {
		t.Fatal(err)
	}
	if err := c.Delete(t.Context(), &deletingHost); err != nil {
		t.Fatal(err)
	}
	if _, err := r.Reconcile(t.Context(), requestFor(client.ObjectKeyFromObject(hostB))); err != nil {
		t.Fatal(err)
	}
	assertMetricValue(t, "t4_cluster_condition", map[string]string{"kind": metricKindClusterHost, "condition": "StorageReady", "status": "true"}, 0)
	assertMetricValue(t, "t4_cluster_condition", map[string]string{"kind": metricKindClusterHost, "condition": "StorageReady", "status": "false"}, 0)

	assertMetricLabelsAreBounded(t)
}

func TestDeletionReconcilesProjectTerminatingConditions(t *testing.T) {
	scheme := metricsTestScheme(t)
	deletionTime := metav1.Now()

	workspace := &clusterv1alpha1.T4Workspace{
		ObjectMeta: metav1.ObjectMeta{
			Name: "workspace-a", Namespace: "team", UID: "workspace-uid",
			DeletionTimestamp: &deletionTime, Finalizers: []string{clusterv1alpha1.WorkspaceFinalizer},
		},
		Spec: clusterv1alpha1.T4WorkspaceSpec{RetentionPolicy: clusterv1alpha1.RetentionPolicyDelete},
	}
	blockingSession := &clusterv1alpha1.T4Session{
		ObjectMeta: metav1.ObjectMeta{Name: "blocking-session", Namespace: workspace.Namespace},
		Spec:       clusterv1alpha1.T4SessionSpec{WorkspaceRef: workspace.Name},
	}
	workspaceClient := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Workspace{}).WithObjects(workspace, blockingSession).Build()
	workspaceReconciler := &WorkspaceReconciler{Client: workspaceClient, Scheme: scheme}
	if _, err := workspaceReconciler.Reconcile(t.Context(), requestFor(client.ObjectKeyFromObject(workspace))); err != nil {
		t.Fatal(err)
	}
	assertMetricValue(t, "t4_cluster_condition", map[string]string{"kind": metricKindWorkspace, "condition": "Ready", "status": "true"}, 0)
	assertMetricValue(t, "t4_cluster_condition", map[string]string{"kind": metricKindWorkspace, "condition": "Ready", "status": "false"}, 1)
	if err := workspaceClient.Delete(t.Context(), blockingSession); err != nil {
		t.Fatal(err)
	}
	if _, err := workspaceReconciler.Reconcile(t.Context(), requestFor(client.ObjectKeyFromObject(workspace))); err != nil {
		t.Fatal(err)
	}
	assertMetricValue(t, "t4_cluster_condition", map[string]string{"kind": metricKindWorkspace, "condition": "Ready", "status": "true"}, 0)
	assertMetricValue(t, "t4_cluster_condition", map[string]string{"kind": metricKindWorkspace, "condition": "Ready", "status": "false"}, 0)

	session := &clusterv1alpha1.T4Session{
		ObjectMeta: metav1.ObjectMeta{
			Name: "session-a", Namespace: "team", UID: "session-uid",
			DeletionTimestamp: &deletionTime, Finalizers: []string{clusterv1alpha1.SessionFinalizer},
		},
	}
	controller := true
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{
		Name: SessionPodName(session), Namespace: session.Namespace,
		OwnerReferences: []metav1.OwnerReference{{
			APIVersion: clusterv1alpha1.GroupVersion.String(), Kind: "T4Session", Name: session.Name, UID: session.UID, Controller: &controller,
		}},
	}}
	sessionClient := fake.NewClientBuilder().WithScheme(scheme).WithStatusSubresource(&clusterv1alpha1.T4Session{}).WithObjects(session, pod).Build()
	sessionReconciler := &SessionReconciler{Client: sessionClient, Scheme: scheme}
	if _, err := sessionReconciler.Reconcile(t.Context(), requestFor(client.ObjectKeyFromObject(session))); err != nil {
		t.Fatal(err)
	}
	assertMetricValue(t, "t4_cluster_condition", map[string]string{"kind": metricKindSession, "condition": "Available", "status": "true"}, 0)
	assertMetricValue(t, "t4_cluster_condition", map[string]string{"kind": metricKindSession, "condition": "Available", "status": "false"}, 1)
	if _, err := sessionReconciler.Reconcile(t.Context(), requestFor(client.ObjectKeyFromObject(session))); err != nil {
		t.Fatal(err)
	}
	assertMetricValue(t, "t4_cluster_condition", map[string]string{"kind": metricKindSession, "condition": "Available", "status": "true"}, 0)
	assertMetricValue(t, "t4_cluster_condition", map[string]string{"kind": metricKindSession, "condition": "Available", "status": "false"}, 0)
}

func TestControllerMetricRegistrationIsConcurrentAndIdempotent(t *testing.T) {
	var callers sync.WaitGroup
	for range 32 {
		callers.Add(1)
		go func() {
			defer callers.Done()
			registerControllerMetrics()
		}()
	}
	callers.Wait()

	families, err := controllermetrics.Registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]int{}
	for _, family := range families {
		counts[family.GetName()]++
	}
	for _, name := range []string{"t4_cluster_reconcile_total", "t4_cluster_condition"} {
		if counts[name] != 1 {
			t.Fatalf("registered metric family %q count = %d, want 1", name, counts[name])
		}
	}
}

type getErrorClient struct {
	client.Client
	err error
}

func (c *getErrorClient) Get(context.Context, client.ObjectKey, client.Object, ...client.GetOption) error {
	return c.err
}

func metricsTestScheme(t *testing.T) *runtime.Scheme {
	t.Helper()
	scheme := runtime.NewScheme()
	for _, add := range []func(*runtime.Scheme) error{corev1.AddToScheme, storagev1.AddToScheme, clusterv1alpha1.AddToScheme} {
		if err := add(scheme); err != nil {
			t.Fatal(err)
		}
	}
	return scheme
}

func requestFor(key client.ObjectKey) ctrl.Request {
	return ctrl.Request{NamespacedName: key}
}

func assertMetricValue(t *testing.T, name string, labels map[string]string, want float64) {
	t.Helper()
	got, ok := gatheredMetricValue(t, name, labels)
	if !ok || got != want {
		t.Fatalf("%s%v = %v (present %t), want %v", name, labels, got, ok, want)
	}
}

func gatheredMetricValue(t *testing.T, name string, labels map[string]string) (float64, bool) {
	t.Helper()
	families, err := controllermetrics.Registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, family := range families {
		if family.GetName() != name {
			continue
		}
		for _, metric := range family.GetMetric() {
			metricLabels := make(map[string]string, len(metric.GetLabel()))
			for _, pair := range metric.GetLabel() {
				metricLabels[pair.GetName()] = pair.GetValue()
			}
			if !reflect.DeepEqual(metricLabels, labels) {
				continue
			}
			if metric.Counter != nil {
				return metric.GetCounter().GetValue(), true
			}
			if metric.Gauge != nil {
				return metric.GetGauge().GetValue(), true
			}
		}
	}
	return 0, false
}

func assertMetricLabelsAreBounded(t *testing.T) {
	t.Helper()
	families, err := controllermetrics.Registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	allowedConditions := map[string]map[string]bool{
		metricKindClusterHost: {"Available": true, "CIReady": true, "StorageReady": true},
		metricKindWorkspace:   {"HostReady": true, "Ready": true, "StorageReady": true},
		metricKindSession:     {"Available": true, "HostReady": true, "RuntimeConfigured": true, "WorkspaceReady": true},
	}
	for _, family := range families {
		if family.GetName() != "t4_cluster_reconcile_total" && family.GetName() != "t4_cluster_condition" {
			continue
		}
		for _, metric := range family.GetMetric() {
			labels := make(map[string]string, len(metric.GetLabel()))
			keys := make([]string, 0, len(metric.GetLabel()))
			for _, pair := range metric.GetLabel() {
				labels[pair.GetName()] = pair.GetValue()
				keys = append(keys, pair.GetName())
			}
			sort.Strings(keys)
			if family.GetName() == "t4_cluster_reconcile_total" {
				if !reflect.DeepEqual(keys, []string{"kind", "result"}) {
					t.Fatalf("reconcile labels = %v, want only kind/result", keys)
				}
				if allowedConditions[labels["kind"]] == nil || labels["result"] != "success" && labels["result"] != "error" {
					t.Fatalf("unbounded reconcile label values: %v", labels)
				}
				continue
			}
			if !reflect.DeepEqual(keys, []string{"condition", "kind", "status"}) {
				t.Fatalf("condition labels = %v, want only kind/condition/status", keys)
			}
			if !allowedConditions[labels["kind"]][labels["condition"]] || labels["status"] != "true" && labels["status"] != "false" {
				t.Fatalf("unbounded condition label values: %v", labels)
			}
		}
	}
}
