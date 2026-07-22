package controllers

import (
	"context"
	"testing"

	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	clusterv1alpha1 "github.com/LycaonLLC/t4-code/packages/cluster-operator/api/v1alpha1"
)

func TestSessionRequestsForHostOnlyEnqueuesAffectedSessions(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := clusterv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	objects := []client.Object{
		&clusterv1alpha1.T4Session{ObjectMeta: metav1.ObjectMeta{Name: "session-a", Namespace: "team"}, Spec: clusterv1alpha1.T4SessionSpec{HostRef: "host-a", WorkspaceRef: "workspace-a"}},
		&clusterv1alpha1.T4Session{ObjectMeta: metav1.ObjectMeta{Name: "session-b", Namespace: "team"}, Spec: clusterv1alpha1.T4SessionSpec{HostRef: "host-a", WorkspaceRef: "workspace-b"}},
		&clusterv1alpha1.T4Session{ObjectMeta: metav1.ObjectMeta{Name: "other-host", Namespace: "team"}, Spec: clusterv1alpha1.T4SessionSpec{HostRef: "host-b", WorkspaceRef: "workspace-a"}},
		&clusterv1alpha1.T4Session{ObjectMeta: metav1.ObjectMeta{Name: "other-namespace", Namespace: "other"}, Spec: clusterv1alpha1.T4SessionSpec{HostRef: "host-a", WorkspaceRef: "workspace-a"}},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).
		WithIndex(&clusterv1alpha1.T4Session{}, sessionHostRefIndexField, indexSessionByHostRef).
		WithIndex(&clusterv1alpha1.T4Session{}, sessionWorkspaceRefIndexField, indexSessionByWorkspaceRef).
		WithObjects(objects...).Build()
	r := &SessionReconciler{Client: c, Scheme: scheme}

	requests := r.sessionRequestsForHost(context.Background(), &clusterv1alpha1.T4ClusterHost{ObjectMeta: metav1.ObjectMeta{Name: "host-a", Namespace: "team"}})
	assertRequestSet(t, requests, []types.NamespacedName{
		{Namespace: "team", Name: "session-a"},
		{Namespace: "team", Name: "session-b"},
	})
}

func TestSessionRequestsForWorkspaceOnlyEnqueuesAffectedSessions(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := clusterv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	objects := []client.Object{
		&clusterv1alpha1.T4Session{ObjectMeta: metav1.ObjectMeta{Name: "session-a", Namespace: "team"}, Spec: clusterv1alpha1.T4SessionSpec{HostRef: "host-a", WorkspaceRef: "workspace-a"}},
		&clusterv1alpha1.T4Session{ObjectMeta: metav1.ObjectMeta{Name: "session-b", Namespace: "team"}, Spec: clusterv1alpha1.T4SessionSpec{HostRef: "host-b", WorkspaceRef: "workspace-a"}},
		&clusterv1alpha1.T4Session{ObjectMeta: metav1.ObjectMeta{Name: "other-workspace", Namespace: "team"}, Spec: clusterv1alpha1.T4SessionSpec{HostRef: "host-a", WorkspaceRef: "workspace-b"}},
		&clusterv1alpha1.T4Session{ObjectMeta: metav1.ObjectMeta{Name: "other-namespace", Namespace: "other"}, Spec: clusterv1alpha1.T4SessionSpec{HostRef: "host-a", WorkspaceRef: "workspace-a"}},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).
		WithIndex(&clusterv1alpha1.T4Session{}, sessionHostRefIndexField, indexSessionByHostRef).
		WithIndex(&clusterv1alpha1.T4Session{}, sessionWorkspaceRefIndexField, indexSessionByWorkspaceRef).
		WithObjects(objects...).Build()
	r := &SessionReconciler{Client: c, Scheme: scheme}

	requests := r.sessionRequestsForWorkspace(context.Background(), &clusterv1alpha1.T4Workspace{ObjectMeta: metav1.ObjectMeta{Name: "workspace-a", Namespace: "team"}})
	assertRequestSet(t, requests, []types.NamespacedName{
		{Namespace: "team", Name: "session-a"},
		{Namespace: "team", Name: "session-b"},
	})
}
