package controllers

import (
	"context"
	"testing"

	corev1 "k8s.io/api/core/v1"
	storagev1 "k8s.io/api/storage/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	clusterv1alpha1 "github.com/LycaonLLC/t4-code/packages/cluster-operator/api/v1alpha1"
)

func TestWorkspaceRequestsForPVC(t *testing.T) {
	workspace := &clusterv1alpha1.T4Workspace{ObjectMeta: metav1.ObjectMeta{
		Name: "workspace-a", Namespace: "team", UID: "workspace-uid",
	}}
	validPVC := func() *corev1.PersistentVolumeClaim {
		return &corev1.PersistentVolumeClaim{ObjectMeta: metav1.ObjectMeta{
			Name:      WorkspacePVCName(workspace),
			Namespace: workspace.Namespace,
			Labels: map[string]string{
				workspacePVCPartOfLabel:    workspacePVCPartOfValue,
				workspacePVCWorkspaceLabel: workspace.Name,
			},
			Annotations: map[string]string{
				clusterv1alpha1.WorkspaceUIDAnnotation: string(workspace.UID),
			},
		}}
	}

	tests := []struct {
		name    string
		mutate  func(*corev1.PersistentVolumeClaim)
		wantKey *types.NamespacedName
	}{
		{
			name:    "retained workspace PVC without owner reference",
			mutate:  func(*corev1.PersistentVolumeClaim) {},
			wantKey: &types.NamespacedName{Namespace: workspace.Namespace, Name: workspace.Name},
		},
		{name: "unrelated PVC", mutate: func(pvc *corev1.PersistentVolumeClaim) { pvc.Labels = nil }},
		{name: "wrong part-of label", mutate: func(pvc *corev1.PersistentVolumeClaim) { pvc.Labels[workspacePVCPartOfLabel] = "other-system" }},
		{name: "missing workspace label", mutate: func(pvc *corev1.PersistentVolumeClaim) { delete(pvc.Labels, workspacePVCWorkspaceLabel) }},
		{name: "missing workspace UID", mutate: func(pvc *corev1.PersistentVolumeClaim) {
			delete(pvc.Annotations, clusterv1alpha1.WorkspaceUIDAnnotation)
		}},
		{name: "wrong deterministic name", mutate: func(pvc *corev1.PersistentVolumeClaim) { pvc.Name = "unrelated" }},
		{name: "missing namespace", mutate: func(pvc *corev1.PersistentVolumeClaim) { pvc.Namespace = "" }},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			pvc := validPVC()
			test.mutate(pvc)
			requests := workspaceRequestsForPVC(context.Background(), pvc)
			if test.wantKey == nil {
				if len(requests) != 0 {
					t.Fatalf("requests = %#v, want none", requests)
				}
				return
			}
			if len(requests) != 1 || requests[0].NamespacedName != *test.wantKey {
				t.Fatalf("requests = %#v, want exactly %v", requests, *test.wantKey)
			}
		})
	}
}

func TestWorkspaceRequestsForStorageClassOnlyEnqueuesAffectedWorkspaces(t *testing.T) {
	scheme := runtime.NewScheme()
	for _, add := range []func(*runtime.Scheme) error{storagev1.AddToScheme, clusterv1alpha1.AddToScheme} {
		if err := add(scheme); err != nil {
			t.Fatal(err)
		}
	}
	objects := []client.Object{
		&clusterv1alpha1.T4ClusterHost{ObjectMeta: metav1.ObjectMeta{Name: "host-a", Namespace: "team"}, Spec: clusterv1alpha1.T4ClusterHostSpec{StorageClassName: "portable-rwx"}},
		&clusterv1alpha1.T4Workspace{ObjectMeta: metav1.ObjectMeta{Name: "workspace-a", Namespace: "team"}, Spec: clusterv1alpha1.T4WorkspaceSpec{HostRef: "host-a"}},
		&clusterv1alpha1.T4ClusterHost{ObjectMeta: metav1.ObjectMeta{Name: "host-b", Namespace: "other"}, Spec: clusterv1alpha1.T4ClusterHostSpec{StorageClassName: "portable-rwx"}},
		&clusterv1alpha1.T4Workspace{ObjectMeta: metav1.ObjectMeta{Name: "workspace-b", Namespace: "other"}, Spec: clusterv1alpha1.T4WorkspaceSpec{HostRef: "host-b"}},
		&clusterv1alpha1.T4ClusterHost{ObjectMeta: metav1.ObjectMeta{Name: "unrelated-host", Namespace: "team"}, Spec: clusterv1alpha1.T4ClusterHostSpec{StorageClassName: "other-class"}},
		&clusterv1alpha1.T4Workspace{ObjectMeta: metav1.ObjectMeta{Name: "unrelated-workspace", Namespace: "team"}, Spec: clusterv1alpha1.T4WorkspaceSpec{HostRef: "unrelated-host"}},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).
		WithIndex(&clusterv1alpha1.T4ClusterHost{}, hostStorageClassIndexField, indexHostByStorageClass).
		WithIndex(&clusterv1alpha1.T4Workspace{}, workspaceHostRefIndexField, indexWorkspaceByHostRef).
		WithObjects(objects...).Build()
	r := &WorkspaceReconciler{Client: c, Scheme: scheme}

	requests := r.workspaceRequestsForStorageClass(context.Background(), &storagev1.StorageClass{ObjectMeta: metav1.ObjectMeta{Name: "portable-rwx"}})
	got := make(map[types.NamespacedName]int, len(requests))
	for _, request := range requests {
		got[request.NamespacedName]++
	}
	want := []types.NamespacedName{{Namespace: "team", Name: "workspace-a"}, {Namespace: "other", Name: "workspace-b"}}
	if len(got) != len(want) {
		t.Fatalf("requests = %#v, want exactly %v", requests, want)
	}
	for _, key := range want {
		if got[key] != 1 {
			t.Fatalf("requests = %#v, want %v exactly once", requests, key)
		}
	}
}

func TestWorkspaceRequestsForHostOnlyEnqueuesAffectedWorkspaces(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := clusterv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	objects := []client.Object{
		&clusterv1alpha1.T4Workspace{ObjectMeta: metav1.ObjectMeta{Name: "workspace-a", Namespace: "team"}, Spec: clusterv1alpha1.T4WorkspaceSpec{HostRef: "host-a"}},
		&clusterv1alpha1.T4Workspace{ObjectMeta: metav1.ObjectMeta{Name: "workspace-b", Namespace: "team"}, Spec: clusterv1alpha1.T4WorkspaceSpec{HostRef: "host-a"}},
		&clusterv1alpha1.T4Workspace{ObjectMeta: metav1.ObjectMeta{Name: "other-host", Namespace: "team"}, Spec: clusterv1alpha1.T4WorkspaceSpec{HostRef: "host-b"}},
		&clusterv1alpha1.T4Workspace{ObjectMeta: metav1.ObjectMeta{Name: "other-namespace", Namespace: "other"}, Spec: clusterv1alpha1.T4WorkspaceSpec{HostRef: "host-a"}},
	}
	c := fake.NewClientBuilder().WithScheme(scheme).
		WithIndex(&clusterv1alpha1.T4Workspace{}, workspaceHostRefIndexField, indexWorkspaceByHostRef).
		WithObjects(objects...).Build()
	r := &WorkspaceReconciler{Client: c, Scheme: scheme}

	requests := r.workspaceRequestsForHost(context.Background(), &clusterv1alpha1.T4ClusterHost{ObjectMeta: metav1.ObjectMeta{Name: "host-a", Namespace: "team"}})
	assertRequestSet(t, requests, []types.NamespacedName{
		{Namespace: "team", Name: "workspace-a"},
		{Namespace: "team", Name: "workspace-b"},
	})
}

func assertRequestSet(t *testing.T, requests []ctrl.Request, want []types.NamespacedName) {
	t.Helper()
	got := make(map[types.NamespacedName]int, len(requests))
	for _, request := range requests {
		got[request.NamespacedName]++
	}
	if len(got) != len(want) {
		t.Fatalf("requests = %#v, want exactly %v", requests, want)
	}
	for _, key := range want {
		if got[key] != 1 {
			t.Fatalf("requests = %#v, want %v exactly once", requests, key)
		}
	}
}
