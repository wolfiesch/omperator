package v1alpha1_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	apiextensions "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions"
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	structuralschema "k8s.io/apiextensions-apiserver/pkg/apiserver/schema"
	"k8s.io/apiextensions-apiserver/pkg/apiserver/schema/cel"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/serializer"
	"k8s.io/apimachinery/pkg/util/validation/field"
	"sigs.k8s.io/yaml"

	clusterv1alpha1 "github.com/wolfiesch/omperator/packages/cluster-operator/api/v1alpha1"
)

func TestKindsAreNamespacedAndRegistered(t *testing.T) {
	scheme := runtime.NewScheme()
	if err := clusterv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"T4ClusterHost", "T4Workspace", "T4Session"} {
		gvk := clusterv1alpha1.GroupVersion.WithKind(kind)
		if _, err := scheme.New(gvk); err != nil {
			t.Fatalf("%s is not registered: %v", gvk, err)
		}
	}
}

func TestStatusIsInfrastructureOnlyAndBounded(t *testing.T) {
	statuses := []struct {
		name       string
		generation int64
		conditions []metav1.Condition
	}{
		{"host", clusterv1alpha1.T4ClusterHostStatus{}.ObservedGeneration, clusterv1alpha1.T4ClusterHostStatus{}.Conditions},
		{"workspace", clusterv1alpha1.T4WorkspaceStatus{}.ObservedGeneration, clusterv1alpha1.T4WorkspaceStatus{}.Conditions},
		{"session", clusterv1alpha1.T4SessionStatus{}.ObservedGeneration, clusterv1alpha1.T4SessionStatus{}.Conditions},
	}
	for _, status := range statuses {
		if status.generation != 0 || status.conditions != nil {
			t.Fatalf("zero %s status must be empty", status.name)
		}
	}

	// Compile-time API guards: infrastructure references are explicit; no OMP ids,
	// prompts, transcript, agent tree, or lifecycle ownership is represented here.
	_ = clusterv1alpha1.T4WorkspaceStatus{PVCName: "pvc", Phase: clusterv1alpha1.InfrastructurePending}
	_ = clusterv1alpha1.T4SessionStatus{PodName: "pod", ServiceName: "service", Phase: clusterv1alpha1.InfrastructurePending}
}

func TestEnumsRejectUnboundedValuesAtTheGoBoundary(t *testing.T) {
	if !clusterv1alpha1.ValidRetentionPolicy(clusterv1alpha1.RetentionPolicyRetain) ||
		!clusterv1alpha1.ValidRetentionPolicy(clusterv1alpha1.RetentionPolicyDelete) ||
		clusterv1alpha1.ValidRetentionPolicy("Archive") {
		t.Fatal("retention policy allowlist is not exact")
	}
	if !clusterv1alpha1.ValidInfrastructurePhase(clusterv1alpha1.InfrastructureRunning) ||
		clusterv1alpha1.ValidInfrastructurePhase("OMPRunning") {
		t.Fatal("infrastructure phase allowlist accepts non-infrastructure state")
	}
	if !clusterv1alpha1.ValidDesiredState(clusterv1alpha1.DesiredStateRunning) ||
		!clusterv1alpha1.ValidDesiredState(clusterv1alpha1.DesiredStateSleeping) ||
		!clusterv1alpha1.ValidDesiredState(clusterv1alpha1.DesiredStateStopped) ||
		clusterv1alpha1.ValidDesiredState("Paused") {
		t.Fatal("desired state allowlist is not exact")
	}
	if !clusterv1alpha1.ValidBrowserPolicy(clusterv1alpha1.BrowserPolicyAllowed) ||
		!clusterv1alpha1.ValidBrowserPolicy(clusterv1alpha1.BrowserPolicyDisabled) ||
		clusterv1alpha1.ValidBrowserPolicy("Required") {
		t.Fatal("browser policy allowlist is not exact")
	}
}

func TestCRDContractConstants(t *testing.T) {
	if got, want := clusterv1alpha1.GroupVersion.String(), "cluster.t4.dev/v1alpha1"; got != want {
		t.Fatalf("group version = %q, want %q", got, want)
	}
	if got, want := clusterv1alpha1.WorkspaceFinalizer, "cluster.t4.dev/workspace-protection"; got != want {
		t.Fatalf("workspace finalizer = %q", got)
	}
	if got, want := clusterv1alpha1.SessionFinalizer, "cluster.t4.dev/session-cleanup"; got != want {
		t.Fatalf("session finalizer = %q", got)
	}
	if got, want := clusterv1alpha1.RWXStorageClassAnnotation, "cluster.t4.dev/access-modes"; got != want {
		t.Fatalf("RWX storage annotation = %q", got)
	}
}

func TestCRDSchemasAreStructuralBoundedAndValidated(t *testing.T) {
	paths := []string{
		"t4clusterhosts.cluster.t4.dev.yaml",
		"t4workspaces.cluster.t4.dev.yaml",
		"t4sessions.cluster.t4.dev.yaml",
	}
	for _, name := range paths {
		raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "deploy", "charts", "t4-cluster", "crds", name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		var crd apiextensionsv1.CustomResourceDefinition
		if err := yaml.Unmarshal(raw, &crd); err != nil {
			t.Fatalf("decode %s: %v", name, err)
		}
		if crd.Spec.Scope != apiextensionsv1.NamespaceScoped {
			t.Fatalf("%s must be namespaced", crd.Name)
		}
		if len(crd.Spec.Versions) != 1 || !crd.Spec.Versions[0].Served || !crd.Spec.Versions[0].Storage {
			t.Fatalf("%s must have one served storage version", crd.Name)
		}
		version := crd.Spec.Versions[0]
		if version.Subresources == nil || version.Subresources.Status == nil {
			t.Fatalf("%s lacks the status subresource", crd.Name)
		}
		if version.Schema == nil || version.Schema.OpenAPIV3Schema == nil {
			t.Fatalf("%s lacks an OpenAPI schema", crd.Name)
		}
		var internal apiextensions.JSONSchemaProps
		if err := apiextensionsv1.Convert_v1_JSONSchemaProps_To_apiextensions_JSONSchemaProps(version.Schema.OpenAPIV3Schema, &internal, nil); err != nil {
			t.Fatalf("convert %s schema: %v", crd.Name, err)
		}
		if _, err := structuralschema.NewStructural(&internal); err != nil {
			t.Fatalf("%s is not structural: %v", crd.Name, err)
		}
		root := version.Schema.OpenAPIV3Schema
		if root.XPreserveUnknownFields != nil && *root.XPreserveUnknownFields {
			t.Fatalf("%s preserves unknown fields", crd.Name)
		}
		status := root.Properties["status"]
		conditions := status.Properties["conditions"]
		if conditions.MaxItems == nil || *conditions.MaxItems > 12 {
			t.Fatalf("%s status conditions are not bounded", crd.Name)
		}
		if _, ok := status.Properties["observedGeneration"]; !ok {
			t.Fatalf("%s status lacks observedGeneration", crd.Name)
		}
		assertBoundedSchema(t, crd.Name+".spec", root.Properties["spec"])
		if crd.Name != "t4clusterhosts.cluster.t4.dev" {
			hostRef := root.Properties["spec"].Properties["hostRef"]
			immutable := false
			for _, validation := range hostRef.XValidations {
				if validation.Rule == "self == oldSelf" {
					immutable = true
				}
			}
			if !immutable {
				t.Fatalf("%s hostRef is mutable", crd.Name)
			}
		}
	}
}

func TestOldObjectsDefaultAndRoundTripDeclaredFields(t *testing.T) {
	tests := []struct {
		fixture string
		crd     string
	}{
		{"v1alpha1-t4clusterhost.yaml", "t4clusterhosts.cluster.t4.dev.yaml"},
		{"v1alpha1-t4workspace.yaml", "t4workspaces.cluster.t4.dev.yaml"},
		{"v1alpha1-t4session.yaml", "t4sessions.cluster.t4.dev.yaml"},
	}

	scheme := runtime.NewScheme()
	if err := clusterv1alpha1.AddToScheme(scheme); err != nil {
		t.Fatal(err)
	}
	decoder := serializer.NewCodecFactory(scheme).UniversalDeserializer()

	for _, tc := range tests {
		t.Run(tc.fixture, func(t *testing.T) {
			fixtureRaw, err := os.ReadFile(filepath.Join("testdata", "compat", tc.fixture))
			if err != nil {
				t.Fatal(err)
			}
			var declared map[string]interface{}
			if err := yaml.Unmarshal(fixtureRaw, &declared); err != nil {
				t.Fatalf("decode fixture: %v", err)
			}

			crdRaw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "deploy", "charts", "t4-cluster", "crds", tc.crd))
			if err != nil {
				t.Fatal(err)
			}
			var crd apiextensionsv1.CustomResourceDefinition
			if err := yaml.Unmarshal(crdRaw, &crd); err != nil {
				t.Fatalf("decode CRD: %v", err)
			}
			if len(crd.Spec.Versions) != 1 || crd.Spec.Versions[0].Name != "v1alpha1" || !crd.Spec.Versions[0].Served || !crd.Spec.Versions[0].Storage {
				t.Fatalf("storage contract changed: %#v", crd.Spec.Versions)
			}

			if tc.fixture == "v1alpha1-t4session.yaml" {
				specSchema := crd.Spec.Versions[0].Schema.OpenAPIV3Schema.Properties["spec"]
				guiSchema := specSchema.Properties["guiEnabled"]
				if guiSchema.Default == nil || string(guiSchema.Default.Raw) != "false" {
					t.Fatalf("guiEnabled schema default = %#v, want false", guiSchema.Default)
				}
				desiredState := specSchema.Properties["desiredState"]
				if desiredState.Default == nil || string(desiredState.Default.Raw) != `"Running"` {
					t.Fatalf("desiredState schema default = %#v, want Running", desiredState.Default)
				}
				browserPolicy := specSchema.Properties["browserPolicy"]
				if browserPolicy.Default == nil || string(browserPolicy.Default.Raw) != `"Disabled"` {
					t.Fatalf("browserPolicy schema default = %#v, want Disabled", browserPolicy.Default)
				}
			}

			admittedJSON, err := json.Marshal(declared)
			if err != nil {
				t.Fatal(err)
			}
			object, gvk, err := decoder.Decode(admittedJSON, nil, nil)
			if err != nil {
				t.Fatalf("decode through registered v1alpha1 API: %v", err)
			}
			if gvk.GroupVersion() != clusterv1alpha1.GroupVersion {
				t.Fatalf("decoded version = %s", gvk.GroupVersion())
			}
			roundTripJSON, err := json.Marshal(object)
			if err != nil {
				t.Fatal(err)
			}
			var roundTripped map[string]interface{}
			if err := json.Unmarshal(roundTripJSON, &roundTripped); err != nil {
				t.Fatal(err)
			}
			assertDeclaredFieldsPreserved(t, "$", declared, roundTripped)
			text := string(roundTripJSON)
			newlyOptional := map[string][]string{
				"v1alpha1-t4clusterhost.yaml": {"runtimeStateStorageProfile"},
				"v1alpha1-t4workspace.yaml":   {"storageClassName", "restoreSnapshotRef", "selectedStorageClassName", "filesystemRoot", "attachmentCount", "snapshotRef"},
				"v1alpha1-t4session.yaml":     {"publicId", "publicHostProfileId", "desiredState", "browserPolicy", "idlePolicy", "cmuxSessionName", "runtimeStateRestoreSnapshotRef", "runtimeGeneration", "generationSecretEpoch", "generationSecretName", "fenceState", "fencingPodUid", "fencingGeneration", "fencingVolumeIdentity", "runtimeStatePVCName", "runtimeStateVolumeIdentity", "runtimeStateStorageClassName", "runtimeStateCapacity", "runtimeStateFilesystemRoot", "runtimeStateSnapshotRef", "podUid"},
			}
			for _, field := range newlyOptional[tc.fixture] {
				if strings.Contains(text, `"`+field+`"`) {
					t.Fatalf("legacy %s round trip rewrote absent optional field %q", tc.fixture, field)
				}
			}
		})
	}
}

func TestWorkspacePublicIDAndStorageMetadataSurviveTypedRoundTripAndDeepCopy(t *testing.T) {
	attachmentCount := int32(3)
	workspace := clusterv1alpha1.T4Workspace{
		Spec: clusterv1alpha1.T4WorkspaceSpec{
			PublicID:           "ws_public",
			StorageClassName:   "portable-rwx",
			RestoreSnapshotRef: &clusterv1alpha1.VolumeSnapshotReference{Name: "workspace-snapshot"},
		},
		Status: clusterv1alpha1.T4WorkspaceStatus{
			SelectedStorageClassName: "portable-rwx",
			FilesystemRoot:           "workspace-root",
			AttachmentCount:          &attachmentCount,
			SnapshotRef:              &clusterv1alpha1.VolumeSnapshotReference{Name: "current-snapshot"},
		},
	}
	raw, err := json.Marshal(workspace)
	if err != nil {
		t.Fatal(err)
	}
	var decoded clusterv1alpha1.T4Workspace
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatal(err)
	}
	copied := decoded.DeepCopy()
	*copied.Status.AttachmentCount = 4
	copied.Spec.RestoreSnapshotRef.Name = "changed"
	if decoded.Spec.PublicID != "ws_public" || decoded.Spec.RestoreSnapshotRef.Name != "workspace-snapshot" ||
		decoded.Status.AttachmentCount == nil || *decoded.Status.AttachmentCount != 3 {
		t.Fatalf("typed round trip or deepcopy lost isolated storage metadata: %#v", decoded)
	}
}

func assertDeclaredFieldsPreserved(t *testing.T, path string, declared, roundTripped interface{}) {
	t.Helper()
	switch expected := declared.(type) {
	case map[string]interface{}:
		actual, ok := roundTripped.(map[string]interface{})
		if !ok {
			t.Fatalf("%s changed type: got %T", path, roundTripped)
		}
		for key, expectedValue := range expected {
			actualValue, found := actual[key]
			if !found {
				t.Fatalf("%s.%s was lost", path, key)
			}
			assertDeclaredFieldsPreserved(t, path+"."+key, expectedValue, actualValue)
		}
	case []interface{}:
		actual, ok := roundTripped.([]interface{})
		if !ok || len(actual) != len(expected) {
			t.Fatalf("%s changed array shape: got %#v", path, roundTripped)
		}
		for index := range expected {
			assertDeclaredFieldsPreserved(t, path, expected[index], actual[index])
		}
	default:
		if !reflect.DeepEqual(declared, roundTripped) {
			t.Fatalf("%s changed from %#v to %#v", path, declared, roundTripped)
		}
	}
}

func TestSessionLifecycleSchemaIsBoundedImmutableAndControllerOwned(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "deploy", "charts", "t4-cluster", "crds", "t4sessions.cluster.t4.dev.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var crd apiextensionsv1.CustomResourceDefinition
	if err := yaml.Unmarshal(raw, &crd); err != nil {
		t.Fatal(err)
	}
	root := crd.Spec.Versions[0].Schema.OpenAPIV3Schema
	spec := root.Properties["spec"]
	status := root.Properties["status"]
	for _, field := range []string{"publicId", "publicHostProfileId", "cmuxSessionName"} {
		property, ok := spec.Properties[field]
		if !ok || property.MaxLength == nil {
			t.Fatalf("spec.%s is absent or unbounded", field)
		}
		immutableOnParent := false
		for _, validation := range spec.XValidations {
			immutableOnParent = immutableOnParent ||
				strings.Contains(validation.Rule, "has(oldSelf."+field+")") &&
					strings.Contains(validation.Rule, "has(self."+field+")") &&
					strings.Contains(validation.Rule, "self."+field+" == oldSelf."+field)
		}
		if !immutableOnParent {
			t.Fatalf("spec.%s can be changed or removed once populated", field)
		}
	}
	cmux := spec.Properties["cmuxSessionName"]
	if *cmux.MaxLength != 63 || cmux.Pattern == "" {
		t.Fatalf("spec.cmuxSessionName bounds are incomplete: %#v", cmux)
	}
	runtimeGeneration, ok := status.Properties["runtimeGeneration"]
	if !ok || runtimeGeneration.MaxLength == nil || *runtimeGeneration.MaxLength != 128 || runtimeGeneration.Pattern == "" {
		t.Fatalf("status.runtimeGeneration is absent or unbounded: %#v", runtimeGeneration)
	}
	if strings.Contains(runtimeGeneration.Pattern, "metadata") || strings.Contains(runtimeGeneration.Pattern, "observedGeneration") {
		t.Fatal("runtime generation validation is coupled to Kubernetes generation metadata")
	}
	if _, found := spec.Properties["runtimeGeneration"]; found {
		t.Fatal("runtime generation is client-writable spec input instead of controller-owned status")
	}
	for _, field := range []string{"generationSecretEpoch", "generationSecretName", "fencingPodUid", "fencingGeneration", "fencingVolumeIdentity", "runtimeStateVolumeIdentity"} {
		property, found := status.Properties[field]
		if !found || property.MaxLength == nil {
			t.Fatalf("status.%s is absent or unbounded: %#v", field, property)
		}
	}
	fenceState, found := status.Properties["fenceState"]
	if !found || len(fenceState.Enum) != 6 {
		t.Fatalf("status.fenceState does not expose the exact bounded state machine: %#v", fenceState)
	}
	idle := spec.Properties["idlePolicy"].Properties["idleSeconds"]
	if idle.Minimum == nil || *idle.Minimum != 60 || idle.Maximum == nil || *idle.Maximum != 2_592_000 {
		t.Fatalf("idle policy bounds changed: %#v", idle)
	}
}

func TestStorageSeparationSchemaIsOptionalImmutableAndInfrastructureOnly(t *testing.T) {
	crds := make(map[string]apiextensionsv1.CustomResourceDefinition)
	for _, name := range []string{"t4clusterhosts.cluster.t4.dev.yaml", "t4workspaces.cluster.t4.dev.yaml", "t4sessions.cluster.t4.dev.yaml"} {
		raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "deploy", "charts", "t4-cluster", "crds", name))
		if err != nil {
			t.Fatal(err)
		}
		var crd apiextensionsv1.CustomResourceDefinition
		if err := yaml.Unmarshal(raw, &crd); err != nil {
			t.Fatal(err)
		}
		crds[name] = crd
	}

	hostSpec := crds["t4clusterhosts.cluster.t4.dev.yaml"].Spec.Versions[0].Schema.OpenAPIV3Schema.Properties["spec"]
	if containsString(hostSpec.Required, "runtimeStateStorageProfile") {
		t.Fatal("legacy hosts unexpectedly require a runtime-state storage profile")
	}
	profile := hostSpec.Properties["runtimeStateStorageProfile"]
	if !containsString(profile.Required, "storageClassName") || !containsString(profile.Required, "size") {
		t.Fatalf("runtime-state storage profile required fields = %v", profile.Required)
	}
	if profile.Properties["volumeSnapshotClassName"].MaxLength == nil {
		t.Fatal("optional CSI snapshot class name is unbounded")
	}

	workspaceRoot := crds["t4workspaces.cluster.t4.dev.yaml"].Spec.Versions[0].Schema.OpenAPIV3Schema
	workspaceSpec := workspaceRoot.Properties["spec"]
	workspaceStatus := workspaceRoot.Properties["status"]
	for _, field := range []string{"storageClassName", "restoreSnapshotRef"} {
		if containsString(workspaceSpec.Required, field) || !hasOptionalImmutability(workspaceSpec, field) {
			t.Fatalf("workspace spec.%s is not optional and removal-protected", field)
		}
	}
	attachments := workspaceStatus.Properties["attachmentCount"]
	if attachments.Minimum == nil || *attachments.Minimum != 0 || attachments.Maximum == nil || *attachments.Maximum != 100_000 {
		t.Fatalf("workspace attachmentCount is not nonnegative and bounded: %#v", attachments)
	}

	sessionRoot := crds["t4sessions.cluster.t4.dev.yaml"].Spec.Versions[0].Schema.OpenAPIV3Schema
	sessionSpec := sessionRoot.Properties["spec"]
	if containsString(sessionSpec.Required, "runtimeStateRestoreSnapshotRef") || !hasOptionalImmutability(sessionSpec, "runtimeStateRestoreSnapshotRef") {
		t.Fatal("session runtimeStateRestoreSnapshotRef is not optional and removal-protected")
	}
	for _, status := range []apiextensionsv1.JSONSchemaProps{workspaceStatus, sessionRoot.Properties["status"]} {
		encoded, err := json.Marshal(status)
		if err != nil {
			t.Fatal(err)
		}
		for _, forbidden := range []string{"prompt", "transcript", "credential", "browserData", "browserProfile"} {
			if strings.Contains(strings.ToLower(string(encoded)), strings.ToLower(forbidden)) {
				t.Fatalf("infrastructure status exposes forbidden data field %q", forbidden)
			}
		}
	}
}

func TestRuntimeStateStorageProfileRejectsZeroSizeAndAcceptsPositiveSize(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "deploy", "charts", "t4-cluster", "crds", "t4clusterhosts.cluster.t4.dev.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	var crd apiextensionsv1.CustomResourceDefinition
	if err := yaml.Unmarshal(raw, &crd); err != nil {
		t.Fatal(err)
	}
	var internal apiextensions.JSONSchemaProps
	root := crd.Spec.Versions[0].Schema.OpenAPIV3Schema
	if err := apiextensionsv1.Convert_v1_JSONSchemaProps_To_apiextensions_JSONSchemaProps(root, &internal, nil); err != nil {
		t.Fatal(err)
	}
	structural, err := structuralschema.NewStructural(&internal)
	if err != nil {
		t.Fatal(err)
	}
	validator := cel.NewValidator(structural, true, 1_000_000)
	if validator == nil {
		t.Fatal("host CRD did not compile a CEL validator")
	}
	validate := func(size string) int {
		object := map[string]interface{}{
			"spec": map[string]interface{}{
				"runtimeStateStorageProfile": map[string]interface{}{
					"storageClassName": "runtime-rwo",
					"size":             size,
				},
			},
		}
		errors, _ := validator.Validate(context.Background(), field.NewPath("host"), structural, object, nil, 10_000_000)
		return len(errors)
	}
	if errors := validate("0Gi"); errors == 0 {
		t.Fatal("zero runtime-state storage size passed CRD CEL admission")
	}
	if errors := validate("1Gi"); errors != 0 {
		t.Fatalf("positive runtime-state storage size failed CRD CEL admission with %d errors", errors)
	}
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func hasOptionalImmutability(schema apiextensionsv1.JSONSchemaProps, field string) bool {
	for _, validation := range schema.XValidations {
		if strings.Contains(validation.Rule, "has(oldSelf."+field+")") &&
			strings.Contains(validation.Rule, "has(self."+field+")") &&
			strings.Contains(validation.Rule, "self."+field+" == oldSelf."+field) {
			return true
		}
	}
	return false
}

func TestCRDsHaveCrossFieldCELAndForbidClientRuntimeAuthority(t *testing.T) {
	for _, name := range []string{"t4clusterhosts.cluster.t4.dev.yaml", "t4workspaces.cluster.t4.dev.yaml", "t4sessions.cluster.t4.dev.yaml"} {
		raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "deploy", "charts", "t4-cluster", "crds", name))
		if err != nil {
			t.Fatal(err)
		}
		text := string(raw)
		if !strings.Contains(text, "x-kubernetes-validations:") {
			t.Fatalf("%s has no CEL validation", name)
		}
		for _, forbidden := range []string{"image:", "prompt:", "shell:", "token:", "ompSession", "agentId", "transcript"} {
			if strings.Contains(text, forbidden) {
				t.Fatalf("%s exposes forbidden authority field %q", name, forbidden)
			}
		}
	}
}

func assertBoundedSchema(t *testing.T, path string, schema apiextensionsv1.JSONSchemaProps) {
	t.Helper()
	if schema.Type == "string" && schema.MaxLength == nil && schema.Enum == nil {
		t.Fatalf("%s is an unbounded string", path)
	}
	if schema.Type == "array" {
		if schema.MaxItems == nil {
			t.Fatalf("%s is an unbounded array", path)
		}
		if schema.Items != nil && schema.Items.Schema != nil {
			assertBoundedSchema(t, path+"[]", *schema.Items.Schema)
		}
	}
	for key, child := range schema.Properties {
		assertBoundedSchema(t, path+"."+key, child)
	}
}
