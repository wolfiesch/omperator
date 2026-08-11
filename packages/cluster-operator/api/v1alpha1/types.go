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
	StorageProbeFinalizer         = "cluster.t4.dev/storage-probe-cleanup"
	SnapshotSourceLabel           = "cluster.t4.dev/snapshot-source"
	SnapshotConsistencyLabel      = "cluster.t4.dev/snapshot-consistency"
	SnapshotGenerationLabel       = "cluster.t4.dev/runtime-generation"
	SnapshotSessionUIDLabel       = "cluster.t4.dev/session-uid"
	SnapshotWorkspaceUIDLabel     = "cluster.t4.dev/workspace-uid"
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

// +kubebuilder:validation:Enum=Running;Sleeping;Stopped
type DesiredState string

const (
	DesiredStateRunning  DesiredState = "Running"
	DesiredStateSleeping DesiredState = "Sleeping"
	DesiredStateStopped  DesiredState = "Stopped"
)

func ValidDesiredState(value DesiredState) bool {
	return value == DesiredStateRunning || value == DesiredStateSleeping || value == DesiredStateStopped
}

// +kubebuilder:validation:Enum=Allowed;Disabled
type BrowserPolicy string

const (
	BrowserPolicyAllowed  BrowserPolicy = "Allowed"
	BrowserPolicyDisabled BrowserPolicy = "Disabled"
)

func ValidBrowserPolicy(value BrowserPolicy) bool {
	return value == BrowserPolicyAllowed || value == BrowserPolicyDisabled
}

// +kubebuilder:validation:XValidation:rule="self.enabled ? has(self.idleSeconds) : !has(self.idleSeconds)",message="idleSeconds is required only when idle policy is enabled"
type IdlePolicy struct {
	Enabled bool `json:"enabled"`
	// +kubebuilder:validation:Minimum=60
	// +kubebuilder:validation:Maximum=2592000
	IdleSeconds *int32 `json:"idleSeconds,omitempty"`
}

// +kubebuilder:validation:Enum=Pending;Provisioning;Starting;Ready;Running;Sleeping;Stopped;Deleting;Failed;Terminating;Unavailable;Degraded;Unknown
type InfrastructurePhase string

const (
	InfrastructurePending      InfrastructurePhase = "Pending"
	InfrastructureProvisioning InfrastructurePhase = "Provisioning"
	InfrastructureStarting     InfrastructurePhase = "Starting"
	InfrastructureReady        InfrastructurePhase = "Ready"
	InfrastructureRunning      InfrastructurePhase = "Running"
	InfrastructureSleeping     InfrastructurePhase = "Sleeping"
	InfrastructureStopped      InfrastructurePhase = "Stopped"
	InfrastructureDeleting     InfrastructurePhase = "Deleting"
	InfrastructureFailed       InfrastructurePhase = "Failed"
	InfrastructureTerminating  InfrastructurePhase = "Terminating"
	InfrastructureUnavailable  InfrastructurePhase = "Unavailable"
	InfrastructureDegraded     InfrastructurePhase = "Degraded"
	InfrastructureUnknown      InfrastructurePhase = "Unknown"
)

func ValidInfrastructurePhase(value InfrastructurePhase) bool {
	switch value {
	case InfrastructurePending, InfrastructureProvisioning, InfrastructureStarting, InfrastructureReady, InfrastructureRunning,
		InfrastructureSleeping, InfrastructureStopped, InfrastructureDeleting, InfrastructureFailed, InfrastructureTerminating,
		InfrastructureUnavailable, InfrastructureDegraded, InfrastructureUnknown:
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

// +kubebuilder:validation:Enum=ReadWriteOncePod;ReadWriteOnce
type RuntimeStateAccessMode string

const (
	RuntimeStateAccessModeReadWriteOncePod RuntimeStateAccessMode = "ReadWriteOncePod"
	RuntimeStateAccessModeReadWriteOnce    RuntimeStateAccessMode = "ReadWriteOnce"
)

func ValidRuntimeStateAccessMode(value RuntimeStateAccessMode) bool {
	return value == "" || value == RuntimeStateAccessModeReadWriteOncePod || value == RuntimeStateAccessModeReadWriteOnce
}

// +kubebuilder:validation:Enum=Supported;Unsupported;Unknown
type StorageCapabilityState string

const (
	StorageCapabilitySupported   StorageCapabilityState = "Supported"
	StorageCapabilityUnsupported StorageCapabilityState = "Unsupported"
	StorageCapabilityUnknown     StorageCapabilityState = "Unknown"
)

type StorageCapabilityObservation struct {
	State StorageCapabilityState `json:"state"`
	// +kubebuilder:validation:MaxLength=64
	Reason string `json:"reason,omitempty"`
}

type StorageCapabilities struct {
	WorkspaceReadWriteMany StorageCapabilityObservation `json:"workspaceReadWriteMany"`
	RuntimeStateReattach   StorageCapabilityObservation `json:"runtimeStateReattach"`
	OnlineExpansion        StorageCapabilityObservation `json:"onlineExpansion"`
	VolumeSnapshots        StorageCapabilityObservation `json:"volumeSnapshots"`
	SnapshotDataSource     StorageCapabilityObservation `json:"snapshotDataSource"`
	ObservedAt             metav1.Time                  `json:"observedAt"`
	// +kubebuilder:validation:MaxLength=253
	WorkspaceStorageClassName string `json:"workspaceStorageClassName,omitempty"`
	// +kubebuilder:validation:MaxLength=253
	RuntimeStateStorageClassName string `json:"runtimeStateStorageClassName,omitempty"`
	// +kubebuilder:validation:MaxLength=253
	VolumeSnapshotClassName string `json:"volumeSnapshotClassName,omitempty"`
}

// +kubebuilder:validation:XValidation:rule="quantity(self.size).isGreaterThan(quantity('0'))",message="size must be greater than zero"
type RuntimeStateStorageProfile struct {
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=253
	// +kubebuilder:validation:Pattern=`^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?(\.[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)*$`
	StorageClassName string            `json:"storageClassName"`
	Size             resource.Quantity `json:"size"`
	// +kubebuilder:default=ReadWriteOncePod
	AccessMode RuntimeStateAccessMode `json:"accessMode,omitempty"`
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=253
	// +kubebuilder:validation:Pattern=`^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?(\.[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)*$`
	VolumeSnapshotClassName string `json:"volumeSnapshotClassName,omitempty"`
}

type VolumeSnapshotReference struct {
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=253
	// +kubebuilder:validation:Pattern=`^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?(\.[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?)*$`
	Name string `json:"name"`
}

type T4ClusterHostSpec struct {
	StorageClassName           string                      `json:"storageClassName"`
	RuntimeStateStorageProfile *RuntimeStateStorageProfile `json:"runtimeStateStorageProfile,omitempty"`
	RuntimeProfiles            []string                    `json:"runtimeProfiles"`
	CIProvider                 *CIProviderReferences       `json:"ciProvider,omitempty"`
	AllowedOrigins             []string                    `json:"allowedOrigins,omitempty"`
}

type T4ClusterHostStatus struct {
	ObservedGeneration int64                `json:"observedGeneration,omitempty"`
	StorageCapabilities *StorageCapabilities `json:"storageCapabilities,omitempty"`
	Conditions          []metav1.Condition   `json:"conditions,omitempty"`
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

// Optional storage selection and restore provenance may be populated on a
// legacy object, but once present they cannot be changed or removed.
// +kubebuilder:validation:XValidation:rule="!has(oldSelf.storageClassName) || (has(self.storageClassName) && self.storageClassName == oldSelf.storageClassName)",message="storageClassName is immutable once set"
// +kubebuilder:validation:XValidation:rule="!has(oldSelf.restoreSnapshotRef) || (has(self.restoreSnapshotRef) && self.restoreSnapshotRef == oldSelf.restoreSnapshotRef)",message="restoreSnapshotRef is immutable once set"
type T4WorkspaceSpec struct {
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=128
	// +kubebuilder:validation:Pattern=`^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$`
	// +kubebuilder:validation:XValidation:rule="self == oldSelf",message="publicId is immutable"
	PublicID string `json:"publicId,omitempty"`
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=253
	// +kubebuilder:validation:Pattern=`^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$`
	// +kubebuilder:validation:XValidation:rule="self == oldSelf",message="hostRef is immutable"
	HostRef string `json:"hostRef"`
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=128
	DisplayName string `json:"displayName"`
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=256
	// +kubebuilder:validation:Pattern=`^[^\x00-\x1F\x7F]+$`
	// +kubebuilder:validation:XValidation:rule="self == oldSelf",message="owner is immutable"
	Owner              string                   `json:"owner"`
	Repository         *RepositoryMetadata      `json:"repository,omitempty"`
	Size               resource.Quantity        `json:"size"`
	AllowCrashConsistentRestore bool                  `json:"allowCrashConsistentRestore,omitempty"`
	// +kubebuilder:default=Preserve
	RestorePublicIDPolicy       RestorePublicIDPolicy `json:"restorePublicIdPolicy,omitempty"`
	StorageClassName   string                   `json:"storageClassName,omitempty"`
	RestoreSnapshotRef *VolumeSnapshotReference `json:"restoreSnapshotRef,omitempty"`
	RetentionPolicy    RetentionPolicy           `json:"retentionPolicy"`
}

type T4WorkspaceStatus struct {
	ObservedGeneration       int64                             `json:"observedGeneration,omitempty"`
	PVCName                  string                            `json:"pvcName,omitempty"`
	PVCPhase                 corev1.PersistentVolumeClaimPhase `json:"pvcPhase,omitempty"`
	Capacity                 resource.Quantity                 `json:"capacity,omitempty"`
	SelectedStorageClassName string                            `json:"selectedStorageClassName,omitempty"`
	FilesystemRoot           string                            `json:"filesystemRoot,omitempty"`
	AttachmentCount          *int32                            `json:"attachmentCount,omitempty"`
	SnapshotRef              *VolumeSnapshotReference          `json:"snapshotRef,omitempty"`
	Phase                    InfrastructurePhase               `json:"phase,omitempty"`
	Conditions               []metav1.Condition                `json:"conditions,omitempty"`
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

// +kubebuilder:validation:Enum=Quiesced;CrashConsistent
type SnapshotConsistency string

const (
	SnapshotConsistencyQuiesced        SnapshotConsistency = "Quiesced"
	SnapshotConsistencyCrashConsistent SnapshotConsistency = "CrashConsistent"
)

// +kubebuilder:validation:Enum=Preserve;Replace
type RestorePublicIDPolicy string

const (
	RestorePublicIDPreserve RestorePublicIDPolicy = "Preserve"
	RestorePublicIDReplace  RestorePublicIDPolicy = "Replace"
)

type CheckpointRequest struct {
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=64
	// +kubebuilder:validation:Pattern=`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`
	ID string `json:"id"`
	// +kubebuilder:default=Quiesced
	Consistency SnapshotConsistency `json:"consistency,omitempty"`
}

type DurableComponentAcknowledgements struct {
	OMP     bool `json:"omp"`
	Cmux    bool `json:"cmux"`
	Browser bool `json:"browser"`
}

type CheckpointStatus struct {
	RequestID         string                            `json:"requestId"`
	RuntimeGeneration string                            `json:"runtimeGeneration"`
	Consistency       SnapshotConsistency               `json:"consistency"`
	DurableAcks       DurableComponentAcknowledgements `json:"durableAcks"`
	WorkspaceSnapshotRef    *VolumeSnapshotReference `json:"workspaceSnapshotRef,omitempty"`
	RuntimeStateSnapshotRef *VolumeSnapshotReference `json:"runtimeStateSnapshotRef,omitempty"`
	CompletedAt       *metav1.Time                      `json:"completedAt,omitempty"`
}

// Optional public identities and the cmux override may be populated on a
// legacy object, but once present they cannot be changed or removed.
// +kubebuilder:validation:XValidation:rule="!has(oldSelf.publicId) || (has(self.publicId) && self.publicId == oldSelf.publicId)",message="publicId is immutable once set"
// +kubebuilder:validation:XValidation:rule="!has(oldSelf.publicHostProfileId) || (has(self.publicHostProfileId) && self.publicHostProfileId == oldSelf.publicHostProfileId)",message="publicHostProfileId is immutable once set"
// +kubebuilder:validation:XValidation:rule="!has(oldSelf.cmuxSessionName) || (has(self.cmuxSessionName) && self.cmuxSessionName == oldSelf.cmuxSessionName)",message="cmuxSessionName is immutable once set"
// +kubebuilder:validation:XValidation:rule="!has(oldSelf.runtimeStateRestoreSnapshotRef) || (has(self.runtimeStateRestoreSnapshotRef) && self.runtimeStateRestoreSnapshotRef == oldSelf.runtimeStateRestoreSnapshotRef)",message="runtimeStateRestoreSnapshotRef is immutable once set"
type T4SessionSpec struct {
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=253
	// +kubebuilder:validation:Pattern=`^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$`
	// +kubebuilder:validation:XValidation:rule="self == oldSelf",message="hostRef is immutable"
	HostRef string `json:"hostRef"`
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=253
	// +kubebuilder:validation:Pattern=`^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$`
	// +kubebuilder:validation:XValidation:rule="self == oldSelf",message="workspaceRef is immutable"
	WorkspaceRef string `json:"workspaceRef"`
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=128
	Title string `json:"title"`
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=64
	// +kubebuilder:validation:Pattern=`^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$`
	// +kubebuilder:validation:XValidation:rule="self == oldSelf",message="runtimeProfile is immutable"
	RuntimeProfile string `json:"runtimeProfile"`

	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=128
	// +kubebuilder:validation:Pattern=`^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$`
	// Populating this field on a legacy object is allowed exactly once.
	PublicID string `json:"publicId,omitempty"`

	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=128
	// +kubebuilder:validation:Pattern=`^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$`
	// Populating this field on a legacy object is allowed exactly once.
	PublicHostProfileID string `json:"publicHostProfileId,omitempty"`

	// +kubebuilder:default=Running
	DesiredState DesiredState `json:"desiredState,omitempty"`

	// +kubebuilder:default=Disabled
	BrowserPolicy BrowserPolicy `json:"browserPolicy,omitempty"`

	IdlePolicy *IdlePolicy `json:"idlePolicy,omitempty"`

	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=63
	// +kubebuilder:validation:Pattern=`^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`
	// Populating this field on a legacy object is allowed exactly once.
	CmuxSessionName string `json:"cmuxSessionName,omitempty"`

	RuntimeStateRestoreSnapshotRef *VolumeSnapshotReference `json:"runtimeStateRestoreSnapshotRef,omitempty"`
	// AllowCrashConsistentRestore must be explicitly true to accept a snapshot
	// labeled CrashConsistent.
	AllowCrashConsistentRestore bool `json:"allowCrashConsistentRestore,omitempty"`
	// Checkpoint is an idempotent operation keyed by ID. Quiesced is fail-closed:
	// all required durable component acknowledgements must be recorded for the
	// exact current runtime generation before either snapshot is accepted.
	Checkpoint *CheckpointRequest `json:"checkpoint,omitempty"`
	// +kubebuilder:default=Preserve
	RestorePublicIDPolicy RestorePublicIDPolicy `json:"restorePublicIdPolicy,omitempty"`

	InitialPromptSecretRef *corev1.LocalObjectReference `json:"initialPromptSecretRef,omitempty"`
	GUIEnabled             bool                         `json:"guiEnabled,omitempty"`
	CI                     *SessionCIMetadata           `json:"ci,omitempty"`
}

// +kubebuilder:validation:Enum=NoPriorWriter;DrainRequired;ShutdownRequested;FenceVerifying;FenceProven;FenceUncertain
type RuntimeFenceState string

const (
	RuntimeFenceNoPriorWriter     RuntimeFenceState = "NoPriorWriter"
	RuntimeFenceDrainRequired     RuntimeFenceState = "DrainRequired"
	RuntimeFenceShutdownRequested RuntimeFenceState = "ShutdownRequested"
	RuntimeFenceVerifying         RuntimeFenceState = "FenceVerifying"
	RuntimeFenceProven            RuntimeFenceState = "FenceProven"
	RuntimeFenceUncertain         RuntimeFenceState = "FenceUncertain"
)

type T4SessionStatus struct {
	ObservedGeneration int64 `json:"observedGeneration,omitempty"`
	// RuntimeGeneration is allocated and advanced only by the controller. It is
	// deliberately unrelated to metadata.generation and ObservedGeneration.
	// +kubebuilder:validation:MinLength=8
	// +kubebuilder:validation:MaxLength=128
	// +kubebuilder:validation:Pattern=`^gen_[A-Za-z0-9_-]{4,124}$`
	RuntimeGeneration string `json:"runtimeGeneration,omitempty"`
	// GenerationSecretEpoch records the generation for which the deterministic
	// Secret name was committed in the same status CAS.
	// +kubebuilder:validation:MinLength=8
	// +kubebuilder:validation:MaxLength=128
	// +kubebuilder:validation:Pattern=`^gen_[A-Za-z0-9_-]{4,124}$`
	GenerationSecretEpoch string `json:"generationSecretEpoch,omitempty"`
	// +kubebuilder:validation:MaxLength=63
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:Pattern=`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`
	GenerationSecretName string            `json:"generationSecretName,omitempty"`
	FenceState           RuntimeFenceState `json:"fenceState,omitempty"`
	// FencingPodUID is the exact old workload identity whose absence must be
	// proven before generation advance.
	// +kubebuilder:validation:MaxLength=128
	FencingPodUID string `json:"fencingPodUid,omitempty"`
	// FencingGeneration remains stable throughout one drain/fence attempt.
	// +kubebuilder:validation:MinLength=8
	// +kubebuilder:validation:MaxLength=128
	// +kubebuilder:validation:Pattern=`^gen_[A-Za-z0-9_-]{4,124}$`
	FencingGeneration string `json:"fencingGeneration,omitempty"`
	// FencingVolumeIdentity is a SHA-256 digest of the old PersistentVolume
	// name. It permits authoritative VolumeAttachment matching without
	// publishing the provider-specific storage coordinate in status.
	// +kubebuilder:validation:MinLength=64
	// +kubebuilder:validation:MaxLength=64
	// +kubebuilder:validation:Pattern=`^[0-9a-f]{64}$`
	FencingVolumeIdentity string `json:"fencingVolumeIdentity,omitempty"`
	// +kubebuilder:validation:MinLength=1
	// +kubebuilder:validation:MaxLength=63
	// +kubebuilder:validation:Pattern=`^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`
	CmuxSessionName     string `json:"cmuxSessionName,omitempty"`
	RuntimeStatePVCName string `json:"runtimeStatePVCName,omitempty"`
	// RuntimeStateVolumeIdentity is a SHA-256 digest of the currently bound
	// PersistentVolume name, retained before a drain begins.
	// +kubebuilder:validation:MinLength=64
	// +kubebuilder:validation:MaxLength=64
	// +kubebuilder:validation:Pattern=`^[0-9a-f]{64}$`
	RuntimeStateVolumeIdentity   string             `json:"runtimeStateVolumeIdentity,omitempty"`
	RuntimeStateStorageClassName string             `json:"runtimeStateStorageClassName,omitempty"`
	RuntimeStateCapacity         *resource.Quantity `json:"runtimeStateCapacity,omitempty"`
	RuntimeStateFilesystemRoot   string             `json:"runtimeStateFilesystemRoot,omitempty"`
	// +kubebuilder:validation:MaxLength=128
	PodUID                  string                   `json:"podUid,omitempty"`
	RuntimeStateSnapshotRef *VolumeSnapshotReference `json:"runtimeStateSnapshotRef,omitempty"`
	Checkpoint *CheckpointStatus `json:"checkpoint,omitempty"`
	PodName                 string                   `json:"podName,omitempty"`
	ServiceName             string                   `json:"serviceName,omitempty"`
	Phase                   InfrastructurePhase      `json:"phase,omitempty"`
	Conditions              []metav1.Condition       `json:"conditions,omitempty"`
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
