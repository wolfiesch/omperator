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
	perCallCELCostLimit  = 1_000_000
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
	case "compatible":
		if len(os.Args) != 4 {
			usage()
		}
		err = validateCompatibility(os.Args[2], os.Args[3])
	case "patch":
		if len(os.Args) != 4 {
			usage()
		}
		err = writeMergePatch(os.Args[2], os.Args[3], os.Stdout)
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
	fmt.Fprintln(os.Stderr, "usage: crd-preflight fixtures CRD_DIRECTORY FIXTURE_DIRECTORY | objects CRD_DIRECTORY | compatible CANDIDATE_CRD_DIRECTORY INSTALLED_CRD_DIRECTORY | patch CANDIDATE_CRD INSTALLED_CRD | served CRD_DIRECTORY")
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

func validateCompatibility(candidateDirectory, installedDirectory string) error {
	installedPaths, err := yamlPaths(installedDirectory)
	if err != nil {
		return err
	}
	if len(installedPaths) == 0 {
		return nil
	}
	candidateCRDs, err := loadCRDs(candidateDirectory)
	if err != nil {
		return err
	}
	installedCRDs, err := loadCRDs(installedDirectory)
	if err != nil {
		return err
	}
	var compatibilityErrors []error
	for name, current := range installedCRDs {
		proposed, found := candidateCRDs[name]
		if !found {
			compatibilityErrors = append(compatibilityErrors, fmt.Errorf("installed CRD %s is removed", name))
			continue
		}
		if current.Spec.Scope != proposed.Spec.Scope {
			compatibilityErrors = append(compatibilityErrors, fmt.Errorf("CRD %s changes scope from %s to %s", name, current.Spec.Scope, proposed.Spec.Scope))
		}
		if !reflect.DeepEqual(current.Spec.Names, proposed.Spec.Names) {
			compatibilityErrors = append(compatibilityErrors, fmt.Errorf("CRD %s changes resource names", name))
		}
		if !reflect.DeepEqual(versionContract(current), versionContract(proposed)) {
			compatibilityErrors = append(compatibilityErrors, fmt.Errorf("CRD %s changes its version, served, or storage contract", name))
		}
		if !reflect.DeepEqual(conversionContract(current), conversionContract(proposed)) {
			compatibilityErrors = append(compatibilityErrors, fmt.Errorf("CRD %s changes conversion configuration", name))
		}
	}
	candidates, err := loadCandidates(candidateDirectory)
	if err != nil {
		return err
	}
	installed, err := loadCandidates(installedDirectory)
	if err != nil {
		return err
	}
	for gvk, current := range installed {
		proposed, found := candidates[gvk]
		if !found {
			compatibilityErrors = append(compatibilityErrors, fmt.Errorf("installed schema for %s/%s %s is removed", gvk.Group, gvk.Version, gvk.Kind))
			continue
		}
		path := fmt.Sprintf("%s/%s %s", gvk.Group, gvk.Version, gvk.Kind)
		if current.crd.Spec.Scope != proposed.crd.Spec.Scope {
			compatibilityErrors = append(compatibilityErrors, fmt.Errorf("%s changes scope from %s to %s", path, current.crd.Spec.Scope, proposed.crd.Spec.Scope))
		}
		if !reflect.DeepEqual(current.crd.Spec.Names, proposed.crd.Spec.Names) {
			compatibilityErrors = append(compatibilityErrors, fmt.Errorf("%s changes resource names", path))
		}
		if current.version.Storage != proposed.version.Storage {
			compatibilityErrors = append(compatibilityErrors, fmt.Errorf("%s changes the storage flag", path))
		}
		if !reflect.DeepEqual(current.version.Subresources, proposed.version.Subresources) {
			compatibilityErrors = append(compatibilityErrors, fmt.Errorf("%s changes subresources", path))
		}
		currentSchema, err := schemaMap(current.version.Schema.OpenAPIV3Schema)
		if err != nil {
			compatibilityErrors = append(compatibilityErrors, fmt.Errorf("%s: encode installed schema: %w", path, err))
			continue
		}
		proposedSchema, err := schemaMap(proposed.version.Schema.OpenAPIV3Schema)
		if err != nil {
			compatibilityErrors = append(compatibilityErrors, fmt.Errorf("%s: encode proposed schema: %w", path, err))
			continue
		}
		stripDescriptions(currentSchema)
		stripDescriptions(proposedSchema)
		compatibilityErrors = append(compatibilityErrors, compareAdditiveSchema(path, currentSchema, proposedSchema)...)
	}
	return errors.Join(compatibilityErrors...)
}

func conversionContract(crd *apiextensionsv1.CustomResourceDefinition) *apiextensionsv1.CustomResourceConversion {
	if crd.Spec.Conversion == nil {
		return &apiextensionsv1.CustomResourceConversion{Strategy: apiextensionsv1.NoneConverter}
	}
	result := crd.Spec.Conversion.DeepCopy()
	if result.Strategy == "" {
		result.Strategy = apiextensionsv1.NoneConverter
	}
	return result
}

type versionContractEntry struct {
	Served  bool
	Storage bool
}

func versionContract(crd *apiextensionsv1.CustomResourceDefinition) map[string]versionContractEntry {
	result := make(map[string]versionContractEntry, len(crd.Spec.Versions))
	for _, version := range crd.Spec.Versions {
		result[version.Name] = versionContractEntry{Served: version.Served, Storage: version.Storage}
	}
	return result
}

// writeMergePatch emits the narrow, resource-version-guarded update used by
// the lifecycle runner. The API server rejects the patch if the installed CRD
// changed or was deleted and recreated after compatibility validation.
func writeMergePatch(candidatePath, installedPath string, output io.Writer) error {
	candidate, err := loadCRD(candidatePath)
	if err != nil {
		return err
	}
	installed, err := loadCRD(installedPath)
	if err != nil {
		return err
	}
	if candidate.Name != installed.Name {
		return fmt.Errorf("candidate CRD %s does not match installed CRD %s", candidate.Name, installed.Name)
	}
	if installed.ResourceVersion == "" || installed.UID == "" {
		return fmt.Errorf("installed CRD %s lacks metadata.resourceVersion or metadata.uid", installed.Name)
	}
	patch := map[string]interface{}{
		"metadata": map[string]interface{}{
			"resourceVersion": installed.ResourceVersion,
			"uid":             installed.UID,
		},
		"spec": candidate.Spec,
	}
	encoder := json.NewEncoder(output)
	if err := encoder.Encode(patch); err != nil {
		return fmt.Errorf("encode merge patch for %s: %w", candidate.Name, err)
	}
	return nil
}

func schemaMap(schema *apiextensionsv1.JSONSchemaProps) (map[string]interface{}, error) {
	raw, err := json.Marshal(schema)
	if err != nil {
		return nil, err
	}
	var result map[string]interface{}
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.UseNumber()
	if err := decoder.Decode(&result); err != nil {
		return nil, err
	}
	return result, nil
}

// compareAdditiveSchema deliberately accepts a narrow evolution surface: an
// existing schema node must keep exactly the same semantics, while an object
// may add new optional properties. This is stricter than merely proving that a
// snapshot of live objects happens to validate and therefore remains safe when
// another writer creates an object immediately before the CRD apply.
func compareAdditiveSchema(path string, current, proposed map[string]interface{}) []error {
	var result []error
	for keyword, currentValue := range current {
		proposedValue, found := proposed[keyword]
		if !found {
			result = append(result, fmt.Errorf("%s removes schema keyword %s", path, keyword))
			continue
		}
		if keyword == "properties" {
			currentProperties, currentOK := currentValue.(map[string]interface{})
			proposedProperties, proposedOK := proposedValue.(map[string]interface{})
			if !currentOK || !proposedOK {
				result = append(result, fmt.Errorf("%s changes properties representation", path))
				continue
			}
			for name, currentProperty := range currentProperties {
				proposedProperty, exists := proposedProperties[name]
				if !exists {
					result = append(result, fmt.Errorf("%s.%s removes an existing property", path, name))
					continue
				}
				currentMap, currentIsMap := currentProperty.(map[string]interface{})
				proposedMap, proposedIsMap := proposedProperty.(map[string]interface{})
				if !currentIsMap || !proposedIsMap {
					if !reflect.DeepEqual(currentProperty, proposedProperty) {
						result = append(result, fmt.Errorf("%s.%s changes schema semantics", path, name))
					}
					continue
				}
				result = append(result, compareAdditiveSchema(path+"."+name, currentMap, proposedMap)...)
			}
			continue
		}
		if keyword == "required" {
			if !sameStringSet(currentValue, proposedValue) {
				result = append(result, fmt.Errorf("%s changes required properties", path))
			}
			continue
		}
		if !reflect.DeepEqual(currentValue, proposedValue) {
			result = append(result, fmt.Errorf("%s changes schema keyword %s", path, keyword))
		}
	}
	for keyword := range proposed {
		if _, found := current[keyword]; found || keyword == "properties" {
			continue
		}
		result = append(result, fmt.Errorf("%s adds schema keyword %s to an existing node", path, keyword))
	}
	return result
}

func sameStringSet(left, right interface{}) bool {
	leftValues, leftOK := left.([]interface{})
	rightValues, rightOK := right.([]interface{})
	if !leftOK || !rightOK || len(leftValues) != len(rightValues) {
		return false
	}
	counts := make(map[string]int, len(leftValues))
	for _, value := range leftValues {
		text, ok := value.(string)
		if !ok {
			return false
		}
		counts[text]++
	}
	for _, value := range rightValues {
		text, ok := value.(string)
		if !ok || counts[text] == 0 {
			return false
		}
		counts[text]--
	}
	return true
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
	crds, err := loadCRDs(directory)
	if err != nil {
		return nil, err
	}
	result := make(map[groupVersionKind]*candidateSchema)
	for name, crd := range crds {
		for index := range crd.Spec.Versions {
			version := &crd.Spec.Versions[index]
			if !version.Served {
				continue
			}
			if version.Schema == nil || version.Schema.OpenAPIV3Schema == nil {
				return nil, fmt.Errorf("%s: served version %s has no OpenAPI schema", name, version.Name)
			}
			internal := &apiextensions.JSONSchemaProps{}
			if err := apiextensionsv1.Convert_v1_JSONSchemaProps_To_apiextensions_JSONSchemaProps(version.Schema.OpenAPIV3Schema, internal, nil); err != nil {
				return nil, fmt.Errorf("%s: convert schema for %s: %w", name, version.Name, err)
			}
			structural, err := structuralschema.NewStructural(internal)
			if err != nil {
				return nil, fmt.Errorf("%s: schema for %s is not structural: %w", name, version.Name, err)
			}
			gvk := groupVersionKind{Group: crd.Spec.Group, Version: version.Name, Kind: crd.Spec.Names.Kind}
			if _, duplicate := result[gvk]; duplicate {
				return nil, fmt.Errorf("%s: duplicate proposed schema for %s/%s %s", name, gvk.Group, gvk.Version, gvk.Kind)
			}
			result[gvk] = &candidateSchema{crd: crd, version: version, internal: internal, structural: structural}
		}
	}
	if len(result) == 0 {
		return nil, fmt.Errorf("%s: no served CRD schemas found", directory)
	}
	return result, nil
}

func loadCRDs(directory string) (map[string]*apiextensionsv1.CustomResourceDefinition, error) {
	paths, err := yamlPaths(directory)
	if err != nil {
		return nil, err
	}
	result := make(map[string]*apiextensionsv1.CustomResourceDefinition, len(paths))
	for _, path := range paths {
		crd, err := loadCRD(path)
		if err != nil {
			return nil, err
		}
		if crd.Name == "" {
			return nil, fmt.Errorf("%s: CRD has no metadata.name", path)
		}
		if _, duplicate := result[crd.Name]; duplicate {
			return nil, fmt.Errorf("%s: duplicate CRD %s", path, crd.Name)
		}
		result[crd.Name] = crd
	}
	return result, nil
}

func loadCRD(path string) (*apiextensionsv1.CustomResourceDefinition, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var crd apiextensionsv1.CustomResourceDefinition
	if err := yaml.Unmarshal(raw, &crd); err != nil {
		return nil, fmt.Errorf("%s: decode CRD: %w", path, err)
	}
	return &crd, nil
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
