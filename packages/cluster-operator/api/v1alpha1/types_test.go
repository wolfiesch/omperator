package v1alpha1_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	apiextensions "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions"
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	structuralschema "k8s.io/apiextensions-apiserver/pkg/apiserver/schema"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/serializer"
	"sigs.k8s.io/yaml"

	clusterv1alpha1 "github.com/LycaonLLC/t4-code/packages/cluster-operator/api/v1alpha1"
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
		if conditions.MaxItems == nil || *conditions.MaxItems > 8 {
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
		})
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
