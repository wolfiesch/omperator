// Package v1alpha1 defines the namespaced Kubernetes infrastructure API for T4 clusters.
// It intentionally contains no OMP session, agent, prompt, transcript, or lifecycle truth.
package v1alpha1

import (
	"k8s.io/apimachinery/pkg/runtime/schema"
	"sigs.k8s.io/controller-runtime/pkg/scheme"
)

var (
	GroupVersion  = schema.GroupVersion{Group: "cluster.t4.dev", Version: "v1alpha1"}
	SchemeBuilder = &scheme.Builder{GroupVersion: GroupVersion}
	AddToScheme   = SchemeBuilder.AddToScheme
)
