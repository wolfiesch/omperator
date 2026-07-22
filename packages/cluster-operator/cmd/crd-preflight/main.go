package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"

	apiextensions "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions"
	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	structuralschema "k8s.io/apiextensions-apiserver/pkg/apiserver/schema"
	"k8s.io/apiextensions-apiserver/pkg/apiserver/schema/cel"
	"k8s.io/apiextensions-apiserver/pkg/apiserver/schema/pruning"
	apiservervalidation "k8s.io/apiextensions-apiserver/pkg/apiserver/validation"
	"k8s.io/apiextensions-apiserver/pkg/controller/openapi/builder"
	"k8s.io/apimachinery/pkg/runtime"
	kubejson "k8s.io/apimachinery/pkg/util/json"
	"k8s.io/apimachinery/pkg/util/validation/field"
	"sigs.k8s.io/yaml"
)

const (
	perCallCELCostLimit = 1_000_000
	runtimeCELCostBudget = 10_000_000
)

type groupVersionKind struct {
	Group   string
	Version string
	Kind    string
}

type candidateSchema struct {
	crd        *apiextensionsv1.CustomResourceDefinition
	version    *apiextensionsv1.CustomResourceDefinitionVersion
	internal   *apiextensions.JSONSchemaProps
	structural *structuralschema.Structural
}

func main() {
	if len(os.Args) < 2 {
		usage()
	}
	var err error
	switch os.Args[1] {
	case "fixtures":
		if len(os.Args) != 4 {
			usage()
		}
		err = validateFixtures(os.Args[2], os.Args[3])
	case "objects":
		if len(os.Args) != 3 {
			usage()
		}
		err = validateObjects(os.Args[2], os.Stdin)
	case "served":
		if len(os.Args) != 3 {
			usage()
		}
		err = verifyServedSchemas(os.Args[2], os.Stdin)
	default:
		usage()
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func usage() {
	fmt.Fprintln(os.Stderr, "usage: crd-preflight fixtures CRD_DIRECTORY FIXTURE_DIRECTORY | objects CRD_DIRECTORY | served CRD_DIRECTORY")
	os.Exit(64)
}

func validateFixtures(crdDirectory, fixtureDirectory string) error {
	candidates, err := loadCandidates(crdDirectory)
	if err != nil {
		return err
	}
	paths, err := yamlPaths(fixtureDirectory)
	if err != nil {
		return err
	}
	var validationErrors []error
	for _, path := range paths {
		object, err := decodeYAMLObject(path)
		if err != nil {
			validationErrors = append(validationErrors, err)
			continue
		}
		validationErrors = append(validationErrors, validateCandidateObject(path, "fixture", object, candidates)...)
	}
	return errors.Join(validationErrors...)
}

func validateObjects(crdDirectory string, input io.Reader) error {
	candidates, err := loadCandidates(crdDirectory)
	if err != nil {
		return err
	}
	var list map[string]interface{}
	decoder := json.NewDecoder(input)
	decoder.UseNumber()
	if err := decoder.Decode(&list); err != nil {
		return fmt.Errorf("decode live object list: %w", err)
	}
	if err := kubejson.ConvertMapNumbers(list, 0); err != nil {
		return fmt.Errorf("decode live object list numbers: %w", err)
	}
	var trailing interface{}
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("decode live object list: multiple JSON documents")
		}
		return fmt.Errorf("decode live object list trailing data: %w", err)
	}
	rawItems, found := list["items"]
	if !found {
		return errors.New("decode live object list: missing items")
	}
	items, ok := rawItems.([]interface{})
	if !ok {
		return errors.New("decode live object list: items is not an array")
	}
	var validationErrors []error
	for index, rawItem := range items {
		object, ok := rawItem.(map[string]interface{})
		if !ok {
			validationErrors = append(validationErrors, fmt.Errorf("live object item %d is not an object", index))
			continue
		}
		path, err := liveObjectPath(index, object)
		if err != nil {
			validationErrors = append(validationErrors, err)
			continue
		}
		validationErrors = append(validationErrors, validateCandidateObject(path, "object", object, candidates)...)
	}
	return errors.Join(validationErrors...)
}

func liveObjectPath(index int, object map[string]interface{}) (string, error) {
	metadata, ok := object["metadata"].(map[string]interface{})
	if !ok {
		return "", fmt.Errorf("live object item %d has no metadata", index)
	}
	name, _ := metadata["name"].(string)
	namespace, _ := metadata["namespace"].(string)
	if name == "" || namespace == "" {
		return "", fmt.Errorf("live object item %d must have namespace and name", index)
	}
	return fmt.Sprintf("live object %s/%s", namespace, name), nil
}

func validateCandidateObject(path, fieldRoot string, object map[string]interface{}, candidates map[groupVersionKind]*candidateSchema) []error {
	apiVersion, _ := object["apiVersion"].(string)
	kind, _ := object["kind"].(string)
	group, version, ok := strings.Cut(apiVersion, "/")
	if !ok || group == "" || version == "" || kind == "" {
		return []error{fmt.Errorf("%s: apiVersion and kind must identify a grouped resource", path)}
	}
	candidate, found := candidates[groupVersionKind{Group: group, Version: version, Kind: kind}]
	if !found {
		return []error{fmt.Errorf("%s: no proposed schema for %s %s", path, apiVersion, kind)}
	}
	return validateObject(path, fieldRoot, object, candidate)
}

func validateObject(path, fieldRoot string, object map[string]interface{}, candidate *candidateSchema) []error {
	var result []error
	validator, _, err := apiservervalidation.NewSchemaValidator(candidate.internal)
	if err != nil {
		return []error{fmt.Errorf("%s: build OpenAPI validator: %w", path, err)}
	}
	if errs := apiservervalidation.ValidateCustomResource(field.NewPath(fieldRoot), object, validator); len(errs) > 0 {
		result = append(result, fmt.Errorf("%s: proposed OpenAPI validation failed: %w", path, errs.ToAggregate()))
	}
	celValidator := cel.NewValidator(candidate.structural, true, perCallCELCostLimit)
	if celValidator != nil {
		objectPath := field.NewPath(fieldRoot)
		createErrors, _ := celValidator.Validate(context.Background(), objectPath, candidate.structural, object, nil, runtimeCELCostBudget)
		if len(createErrors) > 0 {
			result = append(result, fmt.Errorf("%s: proposed CEL create validation failed: %w", path, createErrors.ToAggregate()))
		}
		updateErrors, _ := celValidator.Validate(context.Background(), objectPath, candidate.structural, object, object, runtimeCELCostBudget)
		if len(updateErrors) > 0 {
			result = append(result, fmt.Errorf("%s: proposed CEL unchanged-update validation failed: %w", path, updateErrors.ToAggregate()))
		}
	}
	unknownFields := pruning.PruneWithOptions(
		runtime.DeepCopyJSONValue(object),
		candidate.structural,
		true,
		structuralschema.UnknownFieldPathOptions{TrackUnknownFieldPaths: true},
	)
	if len(unknownFields) > 0 {
		result = append(result, fmt.Errorf("%s: proposed structural schema would prune declared fields: %s", path, strings.Join(unknownFields, ", ")))
	}
	return result
}

func verifyServedSchemas(crdDirectory string, discovery io.Reader) error {
	candidates, err := loadCandidates(crdDirectory)
	if err != nil {
		return err
	}
	var document map[string]interface{}
	decoder := json.NewDecoder(discovery)
	decoder.UseNumber()
	if err := decoder.Decode(&document); err != nil {
		return fmt.Errorf("decode served OpenAPI v3 document: %w", err)
	}
	for gvk, candidate := range candidates {
		actual, err := schemaForGVK(document, gvk)
		if err != nil {
			return fmt.Errorf("served schema for %s/%s %s: %w", gvk.Group, gvk.Version, gvk.Kind, err)
		}
		expected, err := generatedSchema(candidate, gvk)
		if err != nil {
			return fmt.Errorf("generate proposed schema for %s/%s %s: %w", gvk.Group, gvk.Version, gvk.Kind, err)
		}
		normalizePublishedSchema(expected)
		normalizePublishedSchema(actual)
		if !reflect.DeepEqual(expected, actual) {
			return fmt.Errorf("served OpenAPI semantics for %s/%s %s do not match the proposed CRD", gvk.Group, gvk.Version, gvk.Kind)
		}
	}
	return nil
}

func generatedSchema(candidate *candidateSchema, gvk groupVersionKind) (map[string]interface{}, error) {
	openapi, err := builder.BuildOpenAPIV3(candidate.crd, candidate.version.Name, builder.Options{})
	if err != nil {
		return nil, err
	}
	raw, err := json.Marshal(openapi)
	if err != nil {
		return nil, err
	}
	var document map[string]interface{}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.UseNumber()
	if err := decoder.Decode(&document); err != nil {
		return nil, err
	}
	return schemaForGVK(document, gvk)
}

func schemaForGVK(document map[string]interface{}, wanted groupVersionKind) (map[string]interface{}, error) {
	components, ok := document["components"].(map[string]interface{})
	if !ok {
		return nil, errors.New("document has no components")
	}
	schemas, ok := components["schemas"].(map[string]interface{})
	if !ok {
		return nil, errors.New("document has no component schemas")
	}
	for _, value := range schemas {
		schema, ok := value.(map[string]interface{})
		if !ok {
			continue
		}
		gvks, ok := schema["x-kubernetes-group-version-kind"].([]interface{})
		if !ok {
			continue
		}
		for _, value := range gvks {
			gvk, ok := value.(map[string]interface{})
			if ok && gvk["group"] == wanted.Group && gvk["version"] == wanted.Version && gvk["kind"] == wanted.Kind {
				return runtime.DeepCopyJSONValue(schema).(map[string]interface{}), nil
			}
		}
	}
	return nil, errors.New("matching x-kubernetes-group-version-kind was not published")
}

func normalizePublishedSchema(schema map[string]interface{}) {
	delete(schema, "x-kubernetes-group-version-kind")
	if properties, ok := schema["properties"].(map[string]interface{}); ok {
		delete(properties, "apiVersion")
		delete(properties, "kind")
		delete(properties, "metadata")
	}
	stripDescriptions(schema)
}

func stripDescriptions(value interface{}) {
	switch value := value.(type) {
	case map[string]interface{}:
		delete(value, "description")
		for _, child := range value {
			stripDescriptions(child)
		}
	case []interface{}:
		for _, child := range value {
			stripDescriptions(child)
		}
	}
}

func loadCandidates(directory string) (map[groupVersionKind]*candidateSchema, error) {
	paths, err := yamlPaths(directory)
	if err != nil {
		return nil, err
	}
	result := make(map[groupVersionKind]*candidateSchema)
	for _, path := range paths {
		raw, err := os.ReadFile(path)
		if err != nil {
			return nil, err
		}
		var crd apiextensionsv1.CustomResourceDefinition
		if err := yaml.Unmarshal(raw, &crd); err != nil {
			return nil, fmt.Errorf("%s: decode CRD: %w", path, err)
		}
		for index := range crd.Spec.Versions {
			version := &crd.Spec.Versions[index]
			if !version.Served {
				continue
			}
			if version.Schema == nil || version.Schema.OpenAPIV3Schema == nil {
				return nil, fmt.Errorf("%s: served version %s has no OpenAPI schema", path, version.Name)
			}
			internal := &apiextensions.JSONSchemaProps{}
			if err := apiextensionsv1.Convert_v1_JSONSchemaProps_To_apiextensions_JSONSchemaProps(version.Schema.OpenAPIV3Schema, internal, nil); err != nil {
				return nil, fmt.Errorf("%s: convert schema for %s: %w", path, version.Name, err)
			}
			structural, err := structuralschema.NewStructural(internal)
			if err != nil {
				return nil, fmt.Errorf("%s: schema for %s is not structural: %w", path, version.Name, err)
			}
			gvk := groupVersionKind{Group: crd.Spec.Group, Version: version.Name, Kind: crd.Spec.Names.Kind}
			if _, duplicate := result[gvk]; duplicate {
				return nil, fmt.Errorf("%s: duplicate proposed schema for %s/%s %s", path, gvk.Group, gvk.Version, gvk.Kind)
			}
			result[gvk] = &candidateSchema{crd: &crd, version: version, internal: internal, structural: structural}
		}
	}
	if len(result) == 0 {
		return nil, fmt.Errorf("%s: no served CRD schemas found", directory)
	}
	return result, nil
}

func decodeYAMLObject(path string) (map[string]interface{}, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	jsonRaw, err := yaml.YAMLToJSON(raw)
	if err != nil {
		return nil, fmt.Errorf("%s: decode YAML: %w", path, err)
	}
	var object map[string]interface{}
	if err := json.Unmarshal(jsonRaw, &object); err != nil {
		return nil, fmt.Errorf("%s: decode object: %w", path, err)
	}
	return object, nil
}

func yamlPaths(directory string) ([]string, error) {
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, err
	}
	paths := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		extension := strings.ToLower(filepath.Ext(entry.Name()))
		if extension == ".yaml" || extension == ".yml" {
			paths = append(paths, filepath.Join(directory, entry.Name()))
		}
	}
	return paths, nil
}
