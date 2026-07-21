package v1alpha1

import (
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const (
	WorkspaceFinalizer           = "cluster.t4.dev/workspace-protection"
	SessionFinalizer             = "cluster.t4.dev/session-cleanup"
	RWXStorageClassAnnotation    = "cluster.t4.dev/access-modes"
	RetainedPVCAnnotation        = "cluster.t4.dev/retained"
	WorkspaceUIDAnnotation       = "cluster.t4.dev/workspace-uid"
	SessionPodSpecHashAnnotation = "cluster.t4.dev/pod-spec-hash"
)

// +kubebuilder:validation:Enum=Retain;Delete
type RetentionPolicy string

const (
	RetentionPolicyRetain RetentionPolicy = "Retain"
	RetentionPolicyDelete RetentionPolicy = "Delete"
)

func ValidRetentionPolicy(value RetentionPolicy) bool {
	return value == RetentionPolicyRetain || value == RetentionPolicyDelete
}

type InfrastructurePhase string

const (
	InfrastructurePending     InfrastructurePhase = "Pending"
	InfrastructureReady       InfrastructurePhase = "Ready"
	InfrastructureRunning     InfrastructurePhase = "Running"
	InfrastructureFailed      InfrastructurePhase = "Failed"
	InfrastructureTerminating InfrastructurePhase = "Terminating"
	InfrastructureUnknown     InfrastructurePhase = "Unknown"
)

func ValidInfrastructurePhase(value InfrastructurePhase) bool {
	switch value {
	case InfrastructurePending, InfrastructureReady, InfrastructureRunning, InfrastructureFailed, InfrastructureTerminating, InfrastructureUnknown:
		return true
	default:
		return false
	}
}

type CIProviderReferences struct {
	SecretRef              *corev1.LocalObjectReference `json:"secretRef,omitempty"`
	ConfigMapRef           corev1.LocalObjectReference  `json:"configMapRef"`
	ServiceAccountAudience string                       `json:"serviceAccountAudience,omitempty"`
}
type T4ClusterHostSpec struct {
	StorageClassName string                `json:"storageClassName"`
	RuntimeProfiles  []string              `json:"runtimeProfiles"`
	CIProvider       *CIProviderReferences `json:"ciProvider,omitempty"`
	AllowedOrigins   []string              `json:"allowedOrigins,omitempty"`
}

type T4ClusterHostStatus struct {
	ObservedGeneration int64              `json:"observedGeneration,omitempty"`
	Conditions         []metav1.Condition `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced,shortName=t4host
// +kubebuilder:printcolumn:name="Storage",type=string,JSONPath=`.spec.storageClassName`
// +kubebuilder:printcolumn:name="Available",type=string,JSONPath=`.status.conditions[?(@.type=="Available")].status`
type T4ClusterHost struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   T4ClusterHostSpec   `json:"spec,omitempty"`
	Status T4ClusterHostStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true
type T4ClusterHostList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []T4ClusterHost `json:"items"`
}

type RepositoryMetadata struct {
	RepositoryID string `json:"repositoryId"`
	Ref          string `json:"ref,omitempty"`
	Commit       string `json:"commit,omitempty"`
}

type T4WorkspaceSpec struct {
	HostRef     string              `json:"hostRef"`
	DisplayName string              `json:"displayName"`
	Owner       string              `json:"owner"`
	Repository  *RepositoryMetadata `json:"repository,omitempty"`
	Size        resource.Quantity   `json:"size"`
	// +kubebuilder:validation:XValidation:rule="self == oldSelf",message="retentionPolicy is immutable"
	RetentionPolicy RetentionPolicy `json:"retentionPolicy"`
}

type T4WorkspaceStatus struct {
	ObservedGeneration int64                             `json:"observedGeneration,omitempty"`
	PVCName            string                            `json:"pvcName,omitempty"`
	PVCPhase           corev1.PersistentVolumeClaimPhase `json:"pvcPhase,omitempty"`
	Capacity           resource.Quantity                 `json:"capacity,omitempty"`
	Phase              InfrastructurePhase               `json:"phase,omitempty"`
	Conditions         []metav1.Condition                `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced,shortName=t4ws
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="PVC",type=string,JSONPath=`.status.pvcName`
type T4Workspace struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   T4WorkspaceSpec   `json:"spec,omitempty"`
	Status T4WorkspaceStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true
type T4WorkspaceList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []T4Workspace `json:"items"`
}

type SessionCIMetadata struct {
	RepositoryID string `json:"repositoryId"`
	Ref          string `json:"ref"`
	Commit       string `json:"commit"`
}

type T4SessionSpec struct {
	HostRef                string                       `json:"hostRef"`
	WorkspaceRef           string                       `json:"workspaceRef"`
	Title                  string                       `json:"title"`
	RuntimeProfile         string                       `json:"runtimeProfile"`
	InitialPromptSecretRef *corev1.LocalObjectReference `json:"initialPromptSecretRef,omitempty"`
	GUIEnabled             bool                         `json:"guiEnabled,omitempty"`
	CI                     *SessionCIMetadata           `json:"ci,omitempty"`
}

type T4SessionStatus struct {
	ObservedGeneration int64               `json:"observedGeneration,omitempty"`
	PodName            string              `json:"podName,omitempty"`
	ServiceName        string              `json:"serviceName,omitempty"`
	Phase              InfrastructurePhase `json:"phase,omitempty"`
	Conditions         []metav1.Condition  `json:"conditions,omitempty"`
}

// +kubebuilder:object:root=true
// +kubebuilder:subresource:status
// +kubebuilder:resource:scope=Namespaced,shortName=t4sess
// +kubebuilder:printcolumn:name="Phase",type=string,JSONPath=`.status.phase`
// +kubebuilder:printcolumn:name="Pod",type=string,JSONPath=`.status.podName`
type T4Session struct {
	metav1.TypeMeta   `json:",inline"`
	metav1.ObjectMeta `json:"metadata,omitempty"`

	Spec   T4SessionSpec   `json:"spec,omitempty"`
	Status T4SessionStatus `json:"status,omitempty"`
}

// +kubebuilder:object:root=true
type T4SessionList struct {
	metav1.TypeMeta `json:",inline"`
	metav1.ListMeta `json:"metadata,omitempty"`
	Items           []T4Session `json:"items"`
}

func init() {
	SchemeBuilder.Register(
		&T4ClusterHost{}, &T4ClusterHostList{},
		&T4Workspace{}, &T4WorkspaceList{},
		&T4Session{}, &T4SessionList{},
	)
}
