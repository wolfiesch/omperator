package controllers

import (
	"context"
	"fmt"
	"net/url"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/types"
	utilvalidation "k8s.io/apimachinery/pkg/util/validation"
)

var (
	configMapKeyPattern = regexp.MustCompile(`^[-._A-Za-z0-9]+$`)
	runtimeImagePattern = regexp.MustCompile(`^(?:(?:[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?|\[[A-Fa-f0-9:]+\])(?::[0-9]+)?/)?[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*@sha256:[a-f0-9]{64}$`)
)

type SessionOMPConfig struct {
	ConfigMapName string
	ModelsKey     string
	SettingsKey   string
}

type ompResourceVersions struct {
	ConfigMap string `json:"configMap"`
}

func (r *SessionReconciler) loadOMPResourceVersions(
	ctx context.Context,
	namespace string,
) (ompResourceVersions, string, string, error) {
	reader := r.APIReader
	if reader == nil {
		reader = r.Client
	}
	var configMap corev1.ConfigMap
	if err := reader.Get(ctx, types.NamespacedName{
		Namespace: namespace,
		Name:      r.OMPConfig.ConfigMapName,
	}, &configMap); err != nil {
		if apierrors.IsNotFound(err) {
			return ompResourceVersions{},
				"OMPConfigMapNotFound",
				"administrator-owned OMP ConfigMap does not exist",
				nil
		}
		return ompResourceVersions{}, "", "", err
	}
	if configMap.Data[r.OMPConfig.ModelsKey] == "" ||
		configMap.Data[r.OMPConfig.SettingsKey] == "" {
		return ompResourceVersions{},
			"OMPConfigMapInvalid",
			"administrator-owned OMP ConfigMap must contain nonempty models and settings keys",
			nil
	}
	if err := validateAuthNoneModelsYAML(configMap.Data[r.OMPConfig.ModelsKey]); err != nil {
		return ompResourceVersions{},
			"OMPModelsAuthenticationUnsafe",
			"OMP models configuration must contain only auth-none providers and no embedded credential fields",
			nil
	}
	if err := validateCredentialFreeSettingsYAML(configMap.Data[r.OMPConfig.SettingsKey]); err != nil {
		return ompResourceVersions{},
			"OMPSettingsAuthenticationUnsafe",
			"OMP settings configuration must not contain embedded credential fields",
			nil
	}
	return ompResourceVersions{ConfigMap: configMap.ResourceVersion}, "", "", nil
}

func mappingValue(node *yaml.Node, key string) *yaml.Node {
	if node == nil || node.Kind != yaml.MappingNode {
		return nil
	}
	for index := 0; index+1 < len(node.Content); index += 2 {
		if node.Content[index].Value == key {
			return node.Content[index+1]
		}
	}
	return nil
}

func canonicalYAMLKey(value string) string {
	return strings.Map(func(character rune) rune {
		if character >= 'A' && character <= 'Z' {
			return character + ('a' - 'A')
		}
		if character >= 'a' && character <= 'z' ||
			character >= '0' && character <= '9' {
			return character
		}
		return -1
	}, value)
}

func validateYAMLStructure(node *yaml.Node) error {
	if node == nil {
		return nil
	}
	if node.Kind == yaml.AliasNode || node.Alias != nil || node.Anchor != "" {
		return fmt.Errorf("YAML aliases and anchors are unsupported")
	}
	if node.Kind == yaml.MappingNode {
		if len(node.Content)%2 != 0 {
			return fmt.Errorf("YAML mapping is malformed")
		}
		seen := make(map[string]struct{}, len(node.Content)/2)
		for index := 0; index < len(node.Content); index += 2 {
			key, value := node.Content[index], node.Content[index+1]
			if key.Kind != yaml.ScalarNode || key.Tag != "!!str" || key.Value == "<<" {
				return fmt.Errorf("YAML mapping keys must be plain strings")
			}
			if _, duplicate := seen[key.Value]; duplicate {
				return fmt.Errorf("YAML mapping contains duplicate key %q", key.Value)
			}
			seen[key.Value] = struct{}{}
			if err := validateYAMLStructure(value); err != nil {
				return err
			}
		}
		return nil
	}
	for _, child := range node.Content {
		if err := validateYAMLStructure(child); err != nil {
			return err
		}
	}
	return nil
}

func credentialBearingYAMLKey(value string) bool {
	canonical := canonicalYAMLKey(value)
	switch canonical {
	case "apikey", "authheader", "authorization", "credential", "password",
		"secret", "token", "accesstoken", "xapikey", "headers":
		return true
	}
	for _, suffix := range []string{
		"apikey",
		"authheader",
		"authorization",
		"credential",
		"password",
		"secret",
		"token",
	} {
		if strings.HasSuffix(canonical, suffix) {
			return true
		}
	}
	return false
}

func forbiddenCredentialField(node *yaml.Node) bool {
	if node == nil {
		return false
	}
	if node.Kind == yaml.MappingNode {
		for index := 0; index+1 < len(node.Content); index += 2 {
			key, value := node.Content[index], node.Content[index+1]
			if credentialBearingYAMLKey(key.Value) {
				return true
			}
			switch canonicalYAMLKey(key.Value) {
			case "headers":
				return true
			case "baseurl", "url", "endpoint":
				if value.Kind == yaml.ScalarNode {
					if parsed, err := url.Parse(value.Value); err == nil &&
						(parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "") {
						return true
					}
				}
			}
			if forbiddenCredentialField(value) {
				return true
			}
		}
		return false
	}
	for _, child := range node.Content {
		if forbiddenCredentialField(child) {
			return true
		}
	}
	return false
}

func validateCredentialFreeSettingsYAML(content string) error {
	var document yaml.Node
	if err := yaml.Unmarshal([]byte(content), &document); err != nil {
		return err
	}
	if len(document.Content) != 1 || document.Content[0].Kind != yaml.MappingNode {
		return fmt.Errorf("settings document must be a mapping")
	}
	root := document.Content[0]
	if err := validateYAMLStructure(root); err != nil {
		return err
	}
	if forbiddenCredentialField(root) {
		return fmt.Errorf("settings document contains a credential-bearing field")
	}
	return nil
}

func validateAuthNoneModelsYAML(content string) error {
	var document yaml.Node
	if err := yaml.Unmarshal([]byte(content), &document); err != nil {
		return err
	}
	if len(document.Content) != 1 || document.Content[0].Kind != yaml.MappingNode {
		return fmt.Errorf("models document must be a mapping")
	}
	root := document.Content[0]
	if err := validateYAMLStructure(root); err != nil {
		return err
	}
	providers := mappingValue(root, "providers")
	if providers == nil ||
		providers.Kind != yaml.MappingNode ||
		len(providers.Content) == 0 {
		return fmt.Errorf("models document must contain providers")
	}
	for index := 0; index+1 < len(providers.Content); index += 2 {
		provider := providers.Content[index+1]
		auth := mappingValue(provider, "auth")
		if provider.Kind != yaml.MappingNode ||
			auth == nil ||
			auth.Kind != yaml.ScalarNode ||
			auth.Value != "none" {
			return fmt.Errorf("provider authentication must be none")
		}
	}
	if forbiddenCredentialField(root) {
		return fmt.Errorf("models document contains a credential-bearing field")
	}
	return nil
}

func (config SessionOMPConfig) validationFailure() (string, string) {
	if config.ConfigMapName == "" || config.ModelsKey == "" || config.SettingsKey == "" {
		return "OMPReferencesMissing",
			"administrator-owned OMP ConfigMap and configuration keys are not configured"
	}
	if len(utilvalidation.IsDNS1123Subdomain(config.ConfigMapName)) != 0 ||
		len(config.ModelsKey) > 253 ||
		!configMapKeyPattern.MatchString(config.ModelsKey) ||
		len(config.SettingsKey) > 253 ||
		!configMapKeyPattern.MatchString(config.SettingsKey) ||
		config.ModelsKey == config.SettingsKey {
		return "OMPReferencesInvalid",
			"administrator-owned OMP configuration references are invalid"
	}
	return "", ""
}

func runtimeImageValidationFailure(image string) (string, string) {
	if image == "" {
		return "RuntimeImageMissing",
			"administrator-owned session runtime image is not configured"
	}
	digestSeparator := strings.Index(image, "@sha256:")
	if digestSeparator <= 0 ||
		digestSeparator > 255 ||
		!runtimeImagePattern.MatchString(image) {
		return "RuntimeImageInvalid",
			"administrator-owned session runtime image must be an exact repository@sha256 digest with 64 lowercase hexadecimal characters"
	}
	return "", ""
}
