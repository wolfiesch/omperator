package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const candidateCRD = `apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: widgets.cluster.t4.dev
spec:
  group: cluster.t4.dev
  scope: Namespaced
  names:
    plural: widgets
    singular: widget
    kind: Widget
    listKind: WidgetList
  versions:
    - name: v1alpha1
      served: true
      storage: true
      subresources:
        status: {}
      schema:
        openAPIV3Schema:
          type: object
          required: [spec]
          properties:
            apiVersion:
              type: string
            kind:
              type: string
            metadata:
              type: object
            spec:
              type: object
              required: [code]
              x-kubernetes-validations:
                - rule: self.code.startsWith('ok')
                  message: code must start with ok
              properties:
                code:
                  type: string
                  maxLength: 3
            status:
              type: object
              properties:
                phase:
                  type: string
                  enum: [Ready]
`

func TestValidateFixturesRejectsProposedSpecTighteningAndCEL(t *testing.T) {
	for _, test := range []struct {
		name          string
		code          string
		expectedError string
	}{
		{name: "openapi maxLength", code: "okay", expectedError: "proposed OpenAPI validation failed"},
		{name: "CEL rule", code: "bad", expectedError: "proposed CEL create validation failed"},
	} {
		t.Run(test.name, func(t *testing.T) {
			crds, fixtures := writeCandidate(t, `apiVersion: cluster.t4.dev/v1alpha1
kind: Widget
metadata:
  name: legacy
spec:
  code: `+test.code+"\n"+`status:
  phase: Ready
`)
			err := validateFixtures(crds, fixtures)
			if err == nil {
				t.Fatal("fixture incompatible with the proposed spec schema was accepted")
			}
			if !strings.Contains(err.Error(), test.expectedError) {
				t.Fatalf("validation error %q does not identify %q", err, test.expectedError)
			}
		})
	}
}

func TestValidateFixturesRejectsPersistedStatusAgainstProposedSchema(t *testing.T) {
	crds, fixtures := writeCandidate(t, `apiVersion: cluster.t4.dev/v1alpha1
kind: Widget
metadata:
  name: legacy
spec:
  code: ok
status:
  phase: Legacy
`)
	if err := validateFixtures(crds, fixtures); err == nil {
		t.Fatal("persisted status incompatible with the proposed status schema was accepted")
	}
}

func TestValidateFixturesRejectsUnchangedLegacyValuesUnderTransitionCEL(t *testing.T) {
	tests := []struct {
		name         string
		fixture      string
		expectedPath string
		candidate    func(string) string
	}{
		{
			name:         "spec transition rule",
			expectedPath: "fixture.spec.code",
			fixture: `apiVersion: cluster.t4.dev/v1alpha1
kind: Widget
metadata:
  name: legacy
spec:
  code: bad
status:
  phase: Ready
`,
			candidate: func(crd string) string {
				crd = strings.Replace(crd, "rule: self.code.startsWith('ok')", `rule: "true"`, 1)
				return strings.Replace(crd, "                  maxLength: 3", "                  maxLength: 3\n                  x-kubernetes-validations:\n                    - rule: oldSelf.startsWith('ok')", 1)
			},
		},
		{
			name:         "status transition rule",
			expectedPath: "fixture.status.phase",
			fixture: `apiVersion: cluster.t4.dev/v1alpha1
kind: Widget
metadata:
  name: legacy
spec:
  code: ok
status:
  phase: Pending
`,
			candidate: func(crd string) string {
				return strings.Replace(crd, "                  enum: [Ready]", "                  enum: [Ready, Pending]\n                  x-kubernetes-validations:\n                    - rule: oldSelf == 'Ready'", 1)
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			crds, fixtures := writeCandidate(t, test.fixture)
			if err := os.WriteFile(filepath.Join(crds, "widget.yaml"), []byte(test.candidate(candidateCRD)), 0o644); err != nil {
				t.Fatal(err)
			}
			err := validateFixtures(crds, fixtures)
			if err == nil {
				t.Fatal("unchanged persisted value blocked by transition CEL was accepted")
			}
			if !strings.Contains(err.Error(), "proposed CEL unchanged-update validation failed") {
				t.Fatalf("validation error does not identify unchanged-update semantics: %v", err)
			}
			if !strings.Contains(err.Error(), test.expectedPath) {
				t.Fatalf("validation error %q does not identify field %q", err, test.expectedPath)
			}
		})
	}
}

func TestValidateObjectsRejectsLiveDataOmittedFromFixtures(t *testing.T) {
	tests := []struct {
		name          string
		candidate     func(string) string
		fixtureCode   string
		fixturePhase  string
		liveCode      string
		livePhase     string
		liveExtra     string
		expectedError string
	}{
		{
			name: "spec OpenAPI narrowing",
			candidate: func(crd string) string {
				return strings.Replace(crd, "                  maxLength: 3", "                  maxLength: 3\n                  enum: [ok1]", 1)
			},
			fixtureCode: "ok1", fixturePhase: "Ready", liveCode: "ok2", livePhase: "Ready",
			expectedError: "proposed OpenAPI validation failed",
		},
		{
			name: "status OpenAPI narrowing",
			candidate: func(crd string) string { return crd },
			fixtureCode: "ok", fixturePhase: "Ready", liveCode: "ok", livePhase: "Legacy",
			expectedError: "proposed OpenAPI validation failed",
		},
		{
			name: "spec CEL create semantics",
			candidate: func(crd string) string { return crd },
			fixtureCode: "ok", fixturePhase: "Ready", liveCode: "bad", livePhase: "Ready",
			expectedError: "proposed CEL create validation failed",
		},
		{
			name: "status CEL create semantics",
			candidate: func(crd string) string {
				return strings.Replace(crd, "                phase:\n                  type: string\n                  enum: [Ready]", "                phase:\n                  type: string\n                  enum: [Ready, Legacy]\n                  x-kubernetes-validations:\n                    - rule: self == 'Ready'", 1)
			},
			fixtureCode: "ok", fixturePhase: "Ready", liveCode: "ok", livePhase: "Legacy",
			expectedError: "proposed CEL create validation failed",
		},
		{
			name: "spec CEL unchanged-update semantics",
			candidate: func(crd string) string {
				crd = strings.Replace(crd, "rule: self.code.startsWith('ok')", `rule: "true"`, 1)
				return strings.Replace(crd, "                  maxLength: 3", "                  maxLength: 3\n                  x-kubernetes-validations:\n                    - rule: oldSelf.startsWith('ok')", 1)
			},
			fixtureCode: "ok", fixturePhase: "Ready", liveCode: "bad", livePhase: "Ready",
			expectedError: "proposed CEL unchanged-update validation failed",
		},
		{
			name: "status CEL unchanged-update semantics",
			candidate: func(crd string) string {
				return strings.Replace(crd, "                  enum: [Ready]", "                  enum: [Ready, Legacy]\n                  x-kubernetes-validations:\n                    - rule: oldSelf == 'Ready'", 1)
			},
			fixtureCode: "ok", fixturePhase: "Ready", liveCode: "ok", livePhase: "Legacy",
			expectedError: "proposed CEL unchanged-update validation failed",
		},
		{
			name: "spec pruning",
			candidate: func(crd string) string { return crd },
			fixtureCode: "ok", fixturePhase: "Ready", liveCode: "ok", livePhase: "Ready", liveExtra: `,"removedSpec":"legacy"`,
			expectedError: "proposed structural schema would prune declared fields",
		},
		{
			name: "status pruning",
			candidate: func(crd string) string { return crd },
			fixtureCode: "ok", fixturePhase: "Ready", liveCode: "ok", livePhase: "Ready", liveExtra: `,"removedStatus":"legacy"`,
			expectedError: "proposed structural schema would prune declared fields",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			fixture := fmt.Sprintf("apiVersion: cluster.t4.dev/v1alpha1\nkind: Widget\nmetadata:\n  name: curated\n  namespace: tenant-a\nspec:\n  code: %s\nstatus:\n  phase: %s\n", test.fixtureCode, test.fixturePhase)
			crds, fixtures := writeCandidate(t, fixture)
			if err := os.WriteFile(filepath.Join(crds, "widget.yaml"), []byte(test.candidate(candidateCRD)), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := validateFixtures(crds, fixtures); err != nil {
				t.Fatalf("curated fixture should not expose the live-only incompatibility: %v", err)
			}
			live := fmt.Sprintf(`{"apiVersion":"v1","kind":"WidgetList","items":[{"apiVersion":"cluster.t4.dev/v1alpha1","kind":"Widget","metadata":{"name":"live","namespace":"tenant-b"},"spec":{"code":%q%s},"status":{"phase":%q%s}}]}`,
				test.liveCode, map[bool]string{true: test.liveExtra, false: ""}[test.name == "spec pruning"], test.livePhase, map[bool]string{true: test.liveExtra, false: ""}[test.name == "status pruning"])
			err := validateObjects(crds, strings.NewReader(live))
			if err == nil {
				t.Fatal("live object incompatible with the proposed schema was accepted")
			}
			if !strings.Contains(err.Error(), "tenant-b/live") || !strings.Contains(err.Error(), test.expectedError) {
				t.Fatalf("validation error %q does not identify live object and %q", err, test.expectedError)
			}
		})
	}
}

func TestValidateObjectsAcceptsKubernetesJSONNumbers(t *testing.T) {
	crds, _ := writeCandidate(t, `apiVersion: cluster.t4.dev/v1alpha1
kind: Widget
metadata:
  name: curated
spec:
  code: ok
`)
	candidate := strings.Replace(candidateCRD, "              required: [code]", "              required: [code, count]", 1)
	candidate = strings.Replace(candidate, "                  maxLength: 3", "                  maxLength: 3\n                count:\n                  type: integer\n                  x-kubernetes-validations:\n                    - rule: self == 9223372036854775807", 1)
	if err := os.WriteFile(filepath.Join(crds, "widget.yaml"), []byte(candidate), 0o644); err != nil {
		t.Fatal(err)
	}
	live := strings.NewReader(`{"apiVersion":"v1","kind":"WidgetList","items":[{"apiVersion":"cluster.t4.dev/v1alpha1","kind":"Widget","metadata":{"name":"live","namespace":"tenant-b"},"spec":{"code":"ok","count":9223372036854775807},"status":{"phase":"Ready"}}]}`)
	if err := validateObjects(crds, live); err != nil {
		t.Fatalf("ordinary Kubernetes JSON integer was rejected: %v", err)
	}
}

func TestVerifyServedSchemasRejectsRetainedEstablishedWithStaleSchema(t *testing.T) {
	crds, _ := writeCandidate(t, `apiVersion: cluster.t4.dev/v1alpha1
kind: Widget
metadata:
  name: legacy
spec:
  code: ok
`)
	staleDiscovery := strings.NewReader(`{
  "openapi": "3.0.0",
  "components": {"schemas": {
    "cluster.t4.dev.v1alpha1.Widget": {
      "type": "object",
      "required": ["spec"],
      "properties": {
        "apiVersion": {"type": "string"},
        "kind": {"type": "string"},
        "metadata": {"type": "object"},
        "spec": {
          "type": "object",
          "required": ["code"],
          "x-kubernetes-validations": [{"rule": "self.code.startsWith('ok')", "message": "code must start with ok"}],
          "properties": {"code": {"type": "string", "maxLength": 8}}
        },
        "status": {"type": "object", "properties": {"phase": {"type": "string", "enum": ["Ready"]}}}
      },
      "x-kubernetes-group-version-kind": [{"group":"cluster.t4.dev","version":"v1alpha1","kind":"Widget"}]
    }
  }}
}`)
	if err := verifyServedSchemas(crds, staleDiscovery); err == nil {
		t.Fatal("stale served OpenAPI schema was accepted after Established")
	}
}

func TestVerifyServedSchemasAcceptsExactProposedSemantics(t *testing.T) {
	crds, _ := writeCandidate(t, `apiVersion: cluster.t4.dev/v1alpha1
kind: Widget
metadata:
  name: legacy
spec:
  code: ok
`)
	discovery := strings.NewReader(`{
  "openapi": "3.0.0",
  "components": {"schemas": {
    "cluster.t4.dev.v1alpha1.Widget": {
      "type": "object",
      "required": ["spec"],
      "properties": {
        "apiVersion": {"type": "string"},
        "kind": {"type": "string"},
        "metadata": {"type": "object"},
        "spec": {
          "type": "object",
          "required": ["code"],
          "x-kubernetes-validations": [{"rule": "self.code.startsWith('ok')", "message": "code must start with ok"}],
          "properties": {"code": {"type": "string", "maxLength": 3}}
        },
        "status": {"type": "object", "properties": {"phase": {"type": "string", "enum": ["Ready"]}}}
      },
      "x-kubernetes-group-version-kind": [{"group":"cluster.t4.dev","version":"v1alpha1","kind":"Widget"}]
    }
  }}
}`)
	if err := verifyServedSchemas(crds, discovery); err != nil {
		t.Fatalf("exact proposed schema rejected: %v", err)
	}
}

func writeCandidate(t *testing.T, fixture string) (string, string) {
	t.Helper()
	root := t.TempDir()
	crds := filepath.Join(root, "crds")
	fixtures := filepath.Join(root, "fixtures")
	for _, directory := range []string{crds, fixtures} {
		if err := os.Mkdir(directory, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(crds, "widget.yaml"), []byte(candidateCRD), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fixtures, "widget.yaml"), []byte(fixture), 0o644); err != nil {
		t.Fatal(err)
	}
	return crds, fixtures
}

