package charttests

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"

	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	"sigs.k8s.io/yaml"
)

const fakeDigest = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func TestChartIsDefaultOff(t *testing.T) {
	output := helmTemplate(t)
	if strings.TrimSpace(output) != "" {
		t.Fatalf("default values rendered workloads/resources:\n%s", output)
	}
}

func TestEnabledChartRendersHARestrictedWorkloads(t *testing.T) {
	output := helmTemplate(t, enabledValues()...)
	assertCount(t, output, "kind: Deployment", 2)
	assertContains(t, output,
		"replicas: 2",
		"replicas: 3",
		"maxUnavailable: 0",
		"kind: PodDisruptionBudget",
		"minAvailable: 2",
		"kubernetes.io/hostname",
		"k3s-worker-02",
		"topologySpreadConstraints:",
		"podAntiAffinity:",
		"readOnlyRootFilesystem: true",
		"runAsNonRoot: true",
		"allowPrivilegeEscalation: false",
		"type: RuntimeDefault",
		"drop:",
		"- ALL",
		"automountServiceAccountToken: false",
		"startupProbe:",
		"readinessProbe:",
		"livenessProbe:",
		"preStop:",
		"path: /drainz",
		"kind: NetworkPolicy",
		"policyTypes:",
		"kind: Role",
		"kind: ClusterRole",
		"coordination.k8s.io",
		"resources:",
	)
	server := documentContainingKind(t, output, "Deployment", "name: \"release-name-t4-cluster-server\"")
	assertContains(t, server,
		"automountServiceAccountToken: false",
		"name: T4_CLUSTER_IDENTITY_PROVIDER",
		"value: \"tailscale\"",
		"name: T4_CLUSTER_TRUSTED_PROXY_CIDRS",
		"value: \"192.0.2.0/24\"",
		"name: kubernetes-api-access",
		"audience: \"https://kubernetes.default.svc\"",
		"expirationSeconds: 3600",
	)
	if strings.Contains(output, "privileged: true") || strings.Contains(output, "hostNetwork: true") || strings.Contains(output, "hostPID: true") {
		t.Fatal("enabled chart contains a privileged shortcut")
	}
	if strings.Contains(output, "kind: PersistentVolumeClaim") || strings.Contains(output, "nfs:") || strings.Contains(output, "hostPath:") {
		t.Fatal("portable chart rendered storage backend or workload PVC")
	}
}

func TestLongReleaseNamesRenderDNSLabelResourceNames(t *testing.T) {
	releaseName := strings.Repeat("r", 53)
	output := helmTemplateRelease(t, releaseName, append(enabledValues(),
		"--set", "ingress.enabled=true",
		"--set-string", "ingress.className=tailscale",
		"--set-string", "ingress.host=operator.example.ts.net",
		"--set", "observability.serviceMonitor.enabled=true",
		"--set", "observability.prometheusRule.enabled=true",
	)...)
	dnsLabel := regexp.MustCompile(`^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$`)
	requiredSuffixes := []string{
		"controller",
		"server",
		"metrics",
		"controller-metrics",
		"session",
		"session-token-reviewer",
		"storage-reader",
	}
	foundSuffixes := make(map[string]bool, len(requiredSuffixes))
	for _, document := range strings.Split(output, "\n---") {
		var object struct {
			Kind     string `json:"kind"`
			Metadata struct {
				Name string `json:"name"`
			} `json:"metadata"`
		}
		if err := yaml.Unmarshal([]byte(document), &object); err != nil {
			t.Fatalf("decode rendered object: %v\n%s", err, document)
		}
		if object.Kind == "" {
			continue
		}
		if len(object.Metadata.Name) > 63 || !dnsLabel.MatchString(object.Metadata.Name) {
			t.Fatalf("rendered %s metadata.name %q is not a DNS label of at most 63 characters", object.Kind, object.Metadata.Name)
		}
		for _, suffix := range requiredSuffixes {
			if strings.HasSuffix(object.Metadata.Name, "-"+suffix) {
				foundSuffixes[suffix] = true
			}
		}
	}
	for _, suffix := range requiredSuffixes {
		if !foundSuffixes[suffix] {
			t.Fatalf("long release render lacks a metadata.name preserving suffix %q", suffix)
		}
	}
}

func TestEachDeploymentUsesZeroUnavailableAndConfiguredAPIAudience(t *testing.T) {
	output := helmTemplate(t, append(enabledValues(), "--set-string", "kubernetes.apiAudience=kubernetes.custom.example")...)
	controller := documentContainingKind(t, output, "Deployment", "name: \"release-name-t4-cluster-controller\"")
	server := documentContainingKind(t, output, "Deployment", "name: \"release-name-t4-cluster-server\"")
	for name, deployment := range map[string]string{"controller": controller, "server": server} {
		assertCount(t, deployment, "maxUnavailable: 0", 1)
		assertContains(t, deployment,
			"automountServiceAccountToken: false",
			"name: T4_KUBERNETES_API_AUDIENCE",
			"value: \"kubernetes.custom.example\"",
			"audience: \"kubernetes.custom.example\"",
		)
		if strings.Contains(deployment, "maxUnavailable: 1") {
			t.Fatalf("%s Deployment permits an unavailable replica", name)
		}
	}
	assertContains(t, server, "audience: \"t4-cluster-internal\"")
}

func TestValuesSchemaRejectsUnsafeNamesProfilesCIDRsAndHalfSelectors(t *testing.T) {
	for name, values := range map[string][]string{
		"cluster host name":                {"--set-string", "clusterHost.name=Bad_Name"},
		"storage class name":               {"--set-string", "storage.adminRWXStorageClass=Bad_Name"},
		"runtime profile":                  {"--set-string", "clusterHost.runtimeProfiles[0]=-bad"},
		"Woodpecker Secret name":           {"--set-string", "woodpecker.existingSecret=Bad_Name", "--set-string", "woodpecker.configMap=woodpecker-config"},
		"Woodpecker ConfigMap name":        {"--set-string", "woodpecker.existingSecret=woodpecker-token", "--set-string", "woodpecker.configMap=Bad_Name"},
		"Woodpecker key":                   {"--set-string", "woodpecker.existingSecret=woodpecker-token", "--set-string", "woodpecker.configMap=woodpecker-config", "--set-string", "woodpecker.tokenKey=bad/key"},
		"Woodpecker audience":              {"--set-string", "woodpecker.serviceAccountAudience=/bad", "--set-string", "woodpecker.configMap=woodpecker-config"},
		"IPv4 default route":               {"--set-string", "server.trustedProxyCIDRs[0]=0.0.0.0/0"},
		"IPv6 default route":               {"--set-string", "server.trustedProxyCIDRs[0]=::/0"},
		"gateway half selector":            {"--set-string", "networkPolicy.gatewayIngress.namespaceSelector.matchLabels.scope=gateway"},
		"observability half selector":      {"--set-string", "networkPolicy.observability.podSelector.matchLabels.scope=metrics"},
		"OMP ConfigMap name":               {"--set-string", "session.omp.configMap=Bad_Name"},
		"OMP models key":                   {"--set-string", "session.omp.modelsKey=bad/key"},
		"removed OMP credential Secret":    {"--set-string", "session.omp.credentialSecret=omp-runtime-credential"},
		"removed OMP credential key":       {"--set-string", "session.omp.credentialKey=MODEL_API_KEY"},
		"removed OMP auth mode":            {"--set", "session.omp.allowUnauthenticated=true"},
		"identical OMP projection keys":    {"--set-string", "session.omp.settingsKey=provider-models"},
		"model route port zero":            {"--set", "networkPolicy.modelRoutePorts[0]=0"},
		"model route port above TCP range": {"--set", "networkPolicy.modelRoutePorts[0]=65536"},
		"duplicate model route port":       {"--set", "networkPolicy.modelRoutePorts[0]=19481", "--set", "networkPolicy.modelRoutePorts[1]=19481"},
		"noninteger model route port":      {"--set-string", "networkPolicy.modelRoutePorts[0]=https"},
		"model route half selector":        {"--set-string", "networkPolicy.modelRoute.namespaceSelector.matchLabels.scope=linkedin-bot"},
		"CI provider port zero":            {"--set", "networkPolicy.ciProviderPorts[0]=0"},
		"CI provider port above TCP range": {"--set", "networkPolicy.ciProviderPorts[0]=65536"},
		"duplicate CI provider port":       {"--set", "networkPolicy.ciProviderPorts[0]=8080", "--set", "networkPolicy.ciProviderPorts[1]=8080"},
		"noninteger CI provider port":      {"--set-string", "networkPolicy.ciProviderPorts[0]=http"},
		"CI provider half selector":        {"--set-string", "networkPolicy.ciProvider.namespaceSelector.matchLabels.scope=linkedin-bot"},
	} {
		t.Run(name, func(t *testing.T) {
			helmTemplateMustFail(t, append(enabledValues(), values...)...)
		})
	}
}

func TestValuesSchemaBoundsRoutePortLists(t *testing.T) {
	for _, field := range []string{"modelRoutePorts", "ciProviderPorts"} {
		t.Run(field, func(t *testing.T) {
			values := enabledValues()
			for index := 0; index < 17; index++ {
				values = append(values, "--set", "networkPolicy."+field+"["+strconv.Itoa(index)+"]="+strconv.Itoa(20000+index))
			}
			helmTemplateMustFail(t, values...)
		})
	}
}

func TestEnabledChartRequiresCommonOMPReferences(t *testing.T) {
	for _, key := range []string{"configMap", "modelsKey", "settingsKey"} {
		t.Run(key, func(t *testing.T) {
			helmTemplateMustFail(t, append(enabledValues(), "--set-string", "session.omp."+key+"=")...)
		})
	}
}

func TestEnabledChartHasNoSessionCredentialMode(t *testing.T) {
	output := helmTemplate(t, enabledValues()...)
	controller := documentContainingKind(t, output, "Deployment", "name: \"release-name-t4-cluster-controller\"")
	if strings.Contains(controller, "T4_SESSION_OMP_CREDENTIAL_") || strings.Contains(controller, "T4_SESSION_OMP_ALLOW_UNAUTHENTICATED") {
		t.Fatal("controller Deployment retained a session credential projection reference")
	}
	assertCount(t, output, "kind: Secret", 0)
}

func TestBuiltInModelGatewayAloneReceivesProviderCredential(t *testing.T) {
	values := append(enabledValues(),
		"--set", "modelGateway.enabled=true",
		"--set", "images.modelGateway.digest="+fakeDigest,
		"--set-string", "modelGateway.upstreamOrigin=https://api.example.test",
		"--set-string", "modelGateway.allowedPaths[0]=/v1/responses",
		"--set-string", "modelGateway.existingSecret=model-provider",
		"--set", "networkPolicy.modelGatewayUpstreamCIDRs[0]=203.0.113.8/32",
	)
	output := helmTemplate(t, values...)
	assertCount(t, output, "kind: Deployment", 3)
	gateway := documentContainingKind(t, output, "Deployment", "name: \"release-name-t4-cluster-model-gateway\"")
	assertContains(t, gateway,
		"image: \"ghcr.io/lycaonllc/t4-model-gateway@"+fakeDigest+"\"",
		"name: T4_MODEL_GATEWAY_UPSTREAM_ORIGIN",
		"value: \"https://api.example.test\"",
		"name: T4_MODEL_GATEWAY_ALLOWED_PATHS",
		`value: "[\"/v1/responses\"]"`,
		"name: provider-credential",
		"secretName: \"model-provider\"",
		"key: \"credential\"",
		"automountServiceAccountToken: false",
		"readOnlyRootFilesystem: true",
	)
	controller := documentContainingKind(t, output, "Deployment", "name: \"release-name-t4-cluster-controller\"")
	server := documentContainingKind(t, output, "Deployment", "name: \"release-name-t4-cluster-server\"")
	if strings.Contains(controller, "model-provider") || strings.Contains(server, "model-provider") {
		t.Fatal("provider credential Secret escaped the model gateway workload")
	}
	policy := documentContainingKind(t, output, "NetworkPolicy", "name: \"release-name-t4-cluster-model-gateway\"")
	assertContains(t, policy,
		"app.kubernetes.io/name: t4-session-runtime",
		"cidr: \"203.0.113.8/32\"",
		"port: 443",
	)
	assertContains(t, output,
		"kind: ServiceAccount\nmetadata:\n  name: \"release-name-t4-cluster-model-gateway\"",
		"kind: Service\nmetadata:\n  name: \"release-name-t4-cluster-model-gateway\"",
		"kind: PodDisruptionBudget\nmetadata:\n  name: \"release-name-t4-cluster-model-gateway\"",
	)
}

func TestBuiltInModelGatewayRequiresPinnedPrivateRoute(t *testing.T) {
	base := append(enabledValues(),
		"--set", "modelGateway.enabled=true",
		"--set", "images.modelGateway.digest="+fakeDigest,
		"--set-string", "modelGateway.upstreamOrigin=https://api.example.test",
		"--set-string", "modelGateway.allowedPaths[0]=/v1/responses",
		"--set-string", "modelGateway.existingSecret=model-provider",
		"--set", "networkPolicy.modelGatewayUpstreamCIDRs[0]=203.0.113.8/32",
	)
	for name, values := range map[string][]string{
		"insecure upstream":      append(append([]string{}, base...), "--set-string", "modelGateway.upstreamOrigin=http://api.example.test"),
		"missing allowed paths":  append(append([]string{}, base...), "--set-string", "modelGateway.allowedPaths={}"),
		"missing provider route": append(append([]string{}, base...), "--set-string", "networkPolicy.modelGatewayUpstreamCIDRs={}"),
		"disabled NetworkPolicy": append(append([]string{}, base...), "--set", "networkPolicy.enabled=false"),
		"session bypass CIDR":    append(append([]string{}, base...), "--set", "networkPolicy.modelRouteCIDRs[0]=198.51.100.4/32"),
	} {
		t.Run(name, func(t *testing.T) { helmTemplateMustFail(t, values...) })
	}
}

func TestSessionOMPReferencesArePassedWithoutCreatingConfigurationObjects(t *testing.T) {
	output := helmTemplate(t, enabledValues()...)
	controller := documentContainingKind(t, output, "Deployment", "name: \"release-name-t4-cluster-controller\"")
	assertContains(t, controller,
		"name: T4_SESSION_OMP_CONFIG_MAP\n              value: \"omp-runtime-config\"",
		"name: T4_SESSION_OMP_MODELS_KEY\n              value: \"provider-models\"",
		"name: T4_SESSION_OMP_SETTINGS_KEY\n              value: \"agent-settings\"",
	)
	assertCount(t, output, "kind: ConfigMap", 0)
	assertCount(t, output, "kind: Secret", 0)
}

func TestNumericDNSReferencesStayQuoted(t *testing.T) {
	output := helmTemplate(t, append(enabledValues(),
		"--set-string", "clusterHost.name=123",
		"--set-string", "storage.adminRWXStorageClass=456",
	)...)
	host := documentContainingKind(t, output, "T4ClusterHost", "name: \"123\"")
	assertContains(t, host, "storageClassName: \"456\"")
}

func TestClusterHostDoesNotAdvertiseIgnoredProjectionConfiguration(t *testing.T) {
	root := repoRoot(t)
	output := helmTemplate(t, enabledValues()...)
	host := documentContainingKind(t, output, "T4ClusterHost", "name: \"t4-cluster\"")
	for _, ignored := range []string{"projection:", "maxWorkspaces", "resyncSeconds"} {
		if strings.Contains(host, ignored) {
			t.Fatalf("rendered T4ClusterHost advertises ignored configuration %q", ignored)
		}
	}

	crdRaw := mustRead(t, filepath.Join(root, "deploy", "charts", "t4-cluster", "crds", "t4clusterhosts.cluster.t4.dev.yaml"))
	var crd apiextensionsv1.CustomResourceDefinition
	if err := yaml.Unmarshal([]byte(crdRaw), &crd); err != nil {
		t.Fatalf("decode cluster host CRD: %v", err)
	}
	spec := crd.Spec.Versions[0].Schema.OpenAPIV3Schema.Properties["spec"]
	if _, ok := spec.Properties["projection"]; ok {
		t.Fatal("T4ClusterHost CRD exposes ignored spec.projection")
	}

	for _, path := range []string{
		filepath.Join(root, "deploy", "charts", "t4-cluster", "values.yaml"),
		filepath.Join(root, "deploy", "charts", "t4-cluster", "values.schema.json"),
		filepath.Join(root, "deploy", "charts", "t4-cluster", "templates", "clusterhost.yaml"),
		filepath.Join(root, "packages", "cluster-operator", "api", "v1alpha1", "types.go"),
	} {
		content := strings.ToLower(mustRead(t, path))
		for _, name := range []string{"projection", "maxworkspaces", "resyncseconds"} {
			if strings.Contains(content, name) {
				t.Fatalf("%s advertises ignored cluster projection configuration %q", path, name)
			}
		}
	}
}

func TestDNSAndSourceSelectorsAreConfigurableAndReleaseScoped(t *testing.T) {
	defaults := helmTemplate(t, enabledValues()...)
	defaultDNS := documentContainingKind(t, defaults, "NetworkPolicy", "name: \"release-name-t4-cluster-dns\"")
	assertContains(t, defaultDNS, "kubernetes.io/metadata.name: kube-system", "k8s-app: kube-dns")
	output := helmTemplate(t, append(enabledValues(),
		"--set-string", "networkPolicy.dns.namespaceSelector.matchLabels.scope=custom-dns-namespace",
		"--set-string", "networkPolicy.dns.podSelector.matchLabels.scope=custom-dns-pod",
		"--set-string", "networkPolicy.gatewayIngress.namespaceSelector.matchLabels.scope=gateway-namespace",
		"--set-string", "networkPolicy.gatewayIngress.podSelector.matchLabels.scope=gateway-pod",
		"--set-string", "networkPolicy.observability.namespaceSelector.matchLabels.scope=metrics-namespace",
		"--set-string", "networkPolicy.observability.podSelector.matchLabels.scope=metrics-pod",
	)...)
	dns := documentContainingKind(t, output, "NetworkPolicy", "name: \"release-name-t4-cluster-dns\"")
	assertContains(t, dns, "scope: custom-dns-namespace", "scope: custom-dns-pod")
	gateway := documentContainingKind(t, output, "NetworkPolicy", "name: \"release-name-t4-cluster-gateway-ingress\"")
	assertContains(t, gateway, "scope: gateway-namespace", "scope: gateway-pod")
	metrics := documentContainingKind(t, output, "NetworkPolicy", "name: \"release-name-t4-cluster-observability\"")
	assertContains(t, metrics,
		"app.kubernetes.io/instance: \"release-name\"",
		"app.kubernetes.io/part-of: \"t4-cluster\"",
		"scope: metrics-namespace",
		"scope: metrics-pod",
	)
}

func TestIngressRequiresTailscaleIdentityAndManagedCertificates(t *testing.T) {
	output := helmTemplate(t, append(enabledValues(),
		"--set", "ingress.enabled=true",
		"--set-string", "ingress.className=tailscale",
		"--set-string", "ingress.host=operator.example.ts.net",
	)...)
	ingress := documentContainingKind(t, output, "Ingress", "name: \"release-name-t4-cluster\"")
	assertContains(t, ingress,
		"ingressClassName: \"tailscale\"",
		"tls:",
		"hosts: [\"operator.example.ts.net\"]",
	)
	if strings.Contains(ingress, "secretName:") {
		t.Fatal("Tailscale-managed ingress invented a TLS Secret reference")
	}
	helmTemplateMustFail(t, append(enabledValues(),
		"--set", "ingress.enabled=true",
		"--set-string", "ingress.className=nginx",
		"--set-string", "ingress.host=operator.example.test",
		"--set-string", "ingress.tls.secretName=operator-tls",
	)...)
	helmTemplateMustFail(t, append(enabledValues(),
		"--set", "ingress.enabled=true",
		"--set-string", "ingress.className=tailscale",
		"--set-string", "ingress.host=operator.example.ts.net",
		"--set", "ingress.tls.enabled=false",
	)...)
}

func TestRBACSeparatesControllerMutationFromServerProjection(t *testing.T) {
	output := helmTemplate(t, enabledValues()...)
	controllerRole := documentContaining(t, output, "name: \"release-name-t4-cluster-controller\"")
	serverRole := documentContaining(t, output, "name: \"release-name-t4-cluster-server\"")
	assertContains(t, controllerRole, "persistentvolumeclaims", "pods", "services", "t4sessions/status", "leases")
	assertContains(t, controllerRole,
		"resources: [configmaps]",
		"resourceNames: [\"omp-runtime-config\"]",
		"verbs: [get]",
	)
	if strings.Contains(controllerRole, "resources: [secrets]") {
		t.Fatal("controller role can read provider credential Secrets")
	}
	assertContains(t, serverRole, "t4clusterhosts", "t4workspaces", "t4sessions", "create", "list", "watch")
	if strings.Contains(serverRole, "secrets") || strings.Contains(serverRole, "persistentvolumeclaims") || strings.Contains(serverRole, "t4sessions/status") {
		t.Fatal("server role can read secrets or mutate controller-owned infrastructure/status")
	}
}
func TestUnauthenticatedOMPControllerCannotReadSecrets(t *testing.T) {
	output := helmTemplate(t, enabledValues()...)
	controllerRole := documentContaining(t, output, "name: \"release-name-t4-cluster-controller\"")
	if strings.Contains(controllerRole, "resources: [secrets]") {
		t.Fatal("unauthenticated OMP controller can read Secrets")
	}
}

func TestChartUsesOnlyProjectedServiceAccountIdentityForInternalPeers(t *testing.T) {
	output := helmTemplate(t, enabledValues()...)
	assertKindCount(t, output, "ServiceAccount", 3)
	assertCount(t, output, "kind: Secret", 0)
	server := documentContainingKind(t, output, "Deployment", "name: \"release-name-t4-cluster-server\"")
	assertContains(t, server,
		"serviceAccountName: \"release-name-t4-cluster-server\"",
		"name: T4_CLUSTER_IDENTITY_TOKEN_FILE",
		"/var/run/secrets/t4-cluster-identity/token",
		"serviceAccountToken:",
		"audience: \"t4-cluster-internal\"",
		"expirationSeconds: 600",
	)
	controller := documentContainingKind(t, output, "Deployment", "name: \"release-name-t4-cluster-controller\"")
	assertContains(t, controller,
		"name: T4_SESSION_SERVICE_ACCOUNT",
		"value: \"release-name-t4-cluster-session\"",
		"name: T4_CLUSTER_SERVER_SERVICE_ACCOUNT",
		"value: \"release-name-t4-cluster-server\"",
	)
	sessionRole := documentContainingKind(t, output, "ClusterRole", "name: \"release-name-t4-cluster-session-token-reviewer\"")
	assertContains(t, sessionRole,
		"apiGroups: [authentication.k8s.io]",
		"resources: [tokenreviews]",
		"verbs: [create]",
	)
	if strings.Count(sessionRole, "- apiGroups:") != 1 || strings.Contains(sessionRole, "get") || strings.Contains(sessionRole, "list") || strings.Contains(sessionRole, "watch") {
		t.Fatalf("session ServiceAccount received permissions beyond TokenReview create:\n%s", sessionRole)
	}
}

func TestNetworkPoliciesDefaultDenyAndAllowOnlyDeclaredFlows(t *testing.T) {
	output := helmTemplate(t, append(enabledValues(),
		"--set", "networkPolicy.kubernetesApiCIDRs[0]=192.0.2.10/32",
		"--set", "networkPolicy.modelRouteCIDRs[0]=198.51.100.4/32",
		"--set", "networkPolicy.modelRoutePorts[0]=19481",
		"--set", "networkPolicy.modelRoutePorts[1]=8443",
		"--set", "networkPolicy.ciProviderCIDRs[0]=203.0.113.8/32",
		"--set-string", "networkPolicy.modelRoute.namespaceSelector.matchLabels.kubernetes\\.io/metadata\\.name=linkedin-bot",
		"--set-string", "networkPolicy.modelRoute.podSelector.matchLabels.app=codex-swap-proxy-fast",
	)...)
	assertContains(t, output,
		"name: \"release-name-t4-cluster-default-deny\"",
		"192.0.2.10/32",
		"198.51.100.4/32",
		"203.0.113.8/32",
		"port: 53",
		"port: 8787",
	)
	sessionPolicy := documentContainingKind(t, output, "NetworkPolicy", "name: \"release-name-t4-cluster-session-host\"")
	assertContains(t, sessionPolicy,
		"192.0.2.10/32", "198.51.100.4/32",
		"kubernetes.io/metadata.name: linkedin-bot", "app: codex-swap-proxy-fast",
		"port: 443", "port: 6443", "port: 19481", "port: 8443",
	)
	if strings.Count(sessionPolicy, "198.51.100.4/32") != 1 {
		t.Fatalf("model CIDR must render once with only its configured TCP ports:\n%s", sessionPolicy)
	}
	assertCount(t, sessionPolicy, "port: 19481", 2)
	assertCount(t, sessionPolicy, "port: 8443", 2)
	if strings.Contains(output, "0.0.0.0/0") {
		t.Fatal("network policy contains broad Internet egress")
	}

	modelOnly := helmTemplate(t, append(enabledValues(),
		"--set", "networkPolicy.modelRouteCIDRs[0]=198.51.100.4/32",
		"--set", "networkPolicy.modelRoutePorts[0]=19481",
	)...)
	modelOnlyPolicy := documentContainingKind(t, modelOnly, "NetworkPolicy", "name: \"release-name-t4-cluster-session-host\"")
	assertContains(t, modelOnlyPolicy, "198.51.100.4/32", "port: 19481")
	if strings.Contains(modelOnlyPolicy, "port: 443") {
		t.Fatalf("model route retained a fixed HTTPS port:\n%s", modelOnlyPolicy)
	}

	withoutPorts := helmTemplate(t, append(enabledValues(),
		"--set", "networkPolicy.modelRouteCIDRs[0]=198.51.100.4/32",
		"--set-string", "networkPolicy.modelRoute.namespaceSelector.matchLabels.scope=linkedin-bot",
		"--set-string", "networkPolicy.modelRoute.podSelector.matchLabels.scope=codex-swap-proxy-fast",
	)...)
	withoutPortsPolicy := documentContainingKind(t, withoutPorts, "NetworkPolicy", "name: \"release-name-t4-cluster-session-host\"")
	if strings.Contains(withoutPortsPolicy, "198.51.100.4/32") || strings.Contains(withoutPortsPolicy, "linkedin-bot") || strings.Contains(withoutPortsPolicy, "codex-swap-proxy-fast") {
		t.Fatalf("model destination without an explicit route port broadened egress:\n%s", withoutPortsPolicy)
	}
}

func TestCIProviderRoutesUseOnlyConfiguredDestinationsAndPorts(t *testing.T) {
	defaults := helmTemplate(t, enabledValues()...)
	defaultServerPolicy := documentContainingKind(t, defaults, "NetworkPolicy", "name: \"release-name-t4-cluster-server-egress\"")
	if strings.Contains(defaultServerPolicy, "port: 443") {
		t.Fatalf("default CI port rendered without a configured destination:\n%s", defaultServerPolicy)
	}

	output := helmTemplate(t, append(enabledValues(),
		"--set", "networkPolicy.ciProviderCIDRs[0]=203.0.113.8/32",
		"--set", "networkPolicy.ciProviderPorts[0]=8080",
		"--set-string", "networkPolicy.ciProvider.namespaceSelector.matchLabels.kubernetes\\.io/metadata\\.name=linkedin-bot",
		"--set-string", "networkPolicy.ciProvider.podSelector.matchLabels.app=woodpecker-server",
	)...)
	serverPolicy := documentContainingKind(t, output, "NetworkPolicy", "name: \"release-name-t4-cluster-server-egress\"")
	assertContains(t, serverPolicy,
		"203.0.113.8/32",
		"kubernetes.io/metadata.name: linkedin-bot",
		"app: woodpecker-server",
		"port: 8080",
	)
	assertCount(t, serverPolicy, "port: 8080", 2)
	if strings.Contains(serverPolicy, "port: 443") {
		t.Fatalf("CI route retained a fixed HTTPS port:\n%s", serverPolicy)
	}
}

func TestWoodpeckerCanUseRotatingProjectedServiceAccountIdentity(t *testing.T) {
	values := append(enabledValues(),
		"--set", "woodpecker.configMap=woodpecker-config",
		"--set", "woodpecker.serviceAccountAudience=woodpecker-ci-trigger",
	)
	output := helmTemplate(t, values...)
	server := documentContainingKind(t, output, "Deployment", "name: \"release-name-t4-cluster-server\"")
	assertContains(t, server,
		"name: T4_WOODPECKER_TOKEN_FILE",
		"/var/run/secrets/t4-ci/token",
		"audience: \"woodpecker-ci-trigger\"",
		"expirationSeconds: 600",
	)
	host := documentContainingKind(t, output, "T4ClusterHost", "name: \"t4-cluster\"")
	assertContains(t, host, "serviceAccountAudience: \"woodpecker-ci-trigger\"", "name: \"woodpecker-config\"")
}

func TestCRDsRemainExplicitAcrossUpgradeAndUninstall(t *testing.T) {
	withoutCRDs := helmTemplate(t, enabledValues()...)
	if strings.Contains(withoutCRDs, "kind: CustomResourceDefinition") {
		t.Fatal("CRDs must live in Helm crds/, not upgrade-rendered templates")
	}
	withCRDs := helmTemplate(t, append([]string{"--include-crds"}, enabledValues()...)...)
	assertCount(t, withCRDs, "kind: CustomResourceDefinition", 3)
	assertContains(t, withCRDs, "t4clusterhosts.cluster.t4.dev", "t4workspaces.cluster.t4.dev", "t4sessions.cluster.t4.dev")

	docs, err := os.ReadFile(filepath.Join(repoRoot(t), "docs", "CLUSTER_OPERATOR.md"))
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{
		"scripts/cluster-ci/crd-lifecycle.sh upgrade",
		"helm upgrade",
		"--skip-crds",
		"helm rollback",
		"helm uninstall",
		"kubectl patch \"crd/$resource\" --type=merge --dry-run=server",
		"metadata.resourceVersion",
		"crd-preflight compatible",
		"crd-preflight patch",
		"--request-timeout=10s",
		"condition=Established",
		"status.storedVersions",
		"Do not rely on `helm upgrade` to change CRDs",
		"Future `v1beta1` conversion and storage procedure",
		"Retain",
		"Delete",
		"CRDs are not removed",
	} {
		if !strings.Contains(string(docs), required) {
			t.Fatalf("operator guide lacks upgrade/uninstall contract %q", required)
		}
	}
}

func TestWorkspaceRetentionPolicyIsImmutable(t *testing.T) {
	root := repoRoot(t)
	raw := mustRead(t, filepath.Join(root, "deploy", "charts", "t4-cluster", "crds", "t4workspaces.cluster.t4.dev.yaml"))
	var crd apiextensionsv1.CustomResourceDefinition
	if err := yaml.Unmarshal([]byte(raw), &crd); err != nil {
		t.Fatalf("decode workspace CRD: %v", err)
	}
	if len(crd.Spec.Versions) != 1 || crd.Spec.Versions[0].Schema == nil || crd.Spec.Versions[0].Schema.OpenAPIV3Schema == nil {
		t.Fatal("workspace CRD lacks its single versioned OpenAPI schema")
	}
	retentionPolicy, ok := crd.Spec.Versions[0].Schema.OpenAPIV3Schema.Properties["spec"].Properties["retentionPolicy"]
	if !ok {
		t.Fatal("workspace CRD lacks spec.retentionPolicy")
	}
	if len(retentionPolicy.Enum) != 2 {
		t.Fatalf("retention policy enum = %v, want exactly Retain and Delete", retentionPolicy.Enum)
	}
	allowed := map[string]bool{`"Retain"`: false, `"Delete"`: false}
	for _, value := range retentionPolicy.Enum {
		if _, expected := allowed[string(value.Raw)]; !expected {
			t.Fatalf("retention policy permits unexpected initial value %s", value.Raw)
		}
		allowed[string(value.Raw)] = true
	}
	for value, found := range allowed {
		if !found {
			t.Fatalf("retention policy rejects initial value %s", value)
		}
	}

	immutable := false
	for _, validation := range retentionPolicy.XValidations {
		if validation.Rule == "self == oldSelf" && validation.Message == "retentionPolicy is immutable" {
			immutable = true
		}
	}
	if !immutable {
		t.Fatal("spec.retentionPolicy lacks the immutable CEL transition rule and clear message")
	}

	api := mustRead(t, filepath.Join(root, "packages", "cluster-operator", "api", "v1alpha1", "types.go"))
	assertContains(t, api,
		"// +kubebuilder:validation:Enum=Retain;Delete\ntype RetentionPolicy string",
		"// +kubebuilder:validation:XValidation:rule=\"self == oldSelf\",message=\"retentionPolicy is immutable\"\n\tRetentionPolicy RetentionPolicy",
	)
}

func TestImageContractsArePinnedAndAuthorityCompatible(t *testing.T) {
	root := repoRoot(t)
	controller := mustRead(t, filepath.Join(root, "cluster", "images", "controller", "Dockerfile"))
	server := mustRead(t, filepath.Join(root, "cluster", "images", "cluster-server", "Dockerfile"))
	session := mustRead(t, filepath.Join(root, "cluster", "images", "session-runtime", "Dockerfile"))
	modelGateway := mustRead(t, filepath.Join(root, "cluster", "images", "model-gateway", "Dockerfile"))
	entrypoint := mustRead(t, filepath.Join(root, "cluster", "images", "session-runtime", "session-entrypoint.sh"))
	for name, content := range map[string]string{"controller": controller, "server": server, "session": session, "model gateway": modelGateway} {
		if !strings.Contains(content, "@sha256:") {
			t.Fatalf("%s image uses an unpinned base", name)
		}
	}
	assertContains(t, session,
		"2eef185481d499c6e04323b71eda550a54bd4550",
		"t4code-17.0.5-appserver-12",
		"t4-omp-authority/1",
		"session-entrypoint.sh",
		"chromium",
		"Xvfb",
	)
	assertContains(t, entrypoint, "packages/cluster-server/src/session-host-main.ts")
	for name, content := range map[string]string{"server": server, "session": session, "model gateway": modelGateway} {
		assertContains(t, content, "pnpm install --frozen-lockfile")
		if strings.Contains(content, "bun install --ignore-scripts --lockfile-only") {
			t.Fatalf("%s image synthesizes an uncommitted dependency lock", name)
		}
	}
	if strings.Contains(session, "ARG BUN_IMAGE") || strings.Contains(session, "ARG OMP_TAG") || strings.Contains(session, "ARG OMP_COMMIT") {
		t.Fatal("session runtime permits overriding a labeled runtime pin")
	}
	assertContains(t, session,
		"refs/tags/t4code-17.0.5-appserver-12",
		"git checkout --detach \"2eef185481d499c6e04323b71eda550a54bd4550\"",
		"snapshot.debian.org/archive/debian/20250721T000000Z",
	)
	assertContains(t, server, "snapshot.debian.org/archive/debian/20250721T000000Z")
	assertContains(t, controller, "ARG TARGETOS\n", "ARG TARGETARCH\n")
	if strings.Contains(controller, "TARGETARCH=amd64") || strings.Contains(controller, "org.opencontainers.image.architecture") {
		t.Fatal("controller image hardcodes or claims a single/unbuilt architecture")
	}
	assertContains(t, server, "packages/cluster-server/src/main.ts")
	assertContains(t, modelGateway, "packages/model-gateway/src/main.ts")
	assertContains(t, entrypoint,
		"T4_CLUSTER_SERVER_SERVICE_ACCOUNT",
		"/var/run/secrets/kubernetes.io/serviceaccount/token",
		"/var/run/secrets/kubernetes.io/serviceaccount/ca.crt",
		"/var/run/secrets/kubernetes.io/serviceaccount/namespace",
		"T4_OMP_CONFIG_SOURCE_DIR",
		"unexpected_arguments",
		`[[ "$#" -eq 0 ]]`,
		`export HOME="${T4_SESSION_STATE_ROOT}/home"`,
		`export PI_CODING_AGENT_DIR="${HOME}/.omp/profiles/${T4_SESSION_NAME}/agent"`,
		`install -m 0600 "${models_source}"`,
		`install -m 0600 "${settings_source}"`,
		`"${PI_CODING_AGENT_DIR}/models.yml"`,
		`"${PI_CODING_AGENT_DIR}/config.yml"`,
		`/usr/local/bin/bun /opt/t4/cluster/images/session-runtime/assert-omp-credentials-absent.ts`,
		"omp_credential_state_present",
	)
}

func TestSessionEntrypointFailsClosedBeforeGUIWithoutPrivateOMPInputs(t *testing.T) {
	entrypoint := filepath.Join(repoRoot(t), "cluster", "images", "session-runtime", "session-entrypoint.sh")
	for _, test := range []struct {
		name          string
		writeModels   bool
		models        string
		writeSettings bool
		settings      string
		unexpectedArg bool
		condition     string
	}{
		{name: "missing models file", writeSettings: true, settings: "settings", condition: "omp_models"},
		{name: "empty settings file", writeModels: true, models: "models", writeSettings: true, condition: "omp_settings"},
		{name: "unexpected argument", writeModels: true, models: "models", writeSettings: true, settings: "settings", unexpectedArg: true, condition: "unexpected_arguments"},
	} {
		t.Run(test.name, func(t *testing.T) {
			root := t.TempDir()
			source := filepath.Join(root, "omp-source")
			projection := filepath.Join(root, "kubernetes")
			bin := filepath.Join(root, "bin")
			for _, directory := range []string{source, projection, bin} {
				if err := os.MkdirAll(directory, 0o700); err != nil {
					t.Fatal(err)
				}
			}
			if test.writeModels {
				if err := os.WriteFile(filepath.Join(source, "models.yml"), []byte(test.models), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			if test.writeSettings {
				if err := os.WriteFile(filepath.Join(source, "config.yml"), []byte(test.settings), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			for _, name := range []string{"token", "ca.crt", "namespace"} {
				if err := os.WriteFile(filepath.Join(projection, name), []byte("projected"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			marker := filepath.Join(root, "xvfb-started")
			fakeXvfb := "#!/usr/bin/env bash\nprintf started > \"${T4_TEST_XVFB_MARKER}\"\n"
			if err := os.WriteFile(filepath.Join(bin, "Xvfb"), []byte(fakeXvfb), 0o700); err != nil {
				t.Fatal(err)
			}
			arguments := []string{entrypoint}
			if test.unexpectedArg {
				arguments = append(arguments, "MODEL_API_KEY")
			}
			command := exec.Command("bash", arguments...)
			command.Env = append(os.Environ(),
				"PATH="+bin+":"+os.Getenv("PATH"),
				"T4_SESSION_STATE_ROOT=/workspace/.t4/sessions/session-a",
				"T4_SESSION_NAME=session-a",
				"T4_AUTHORITY_STATE_DIR=/workspace/.t4/sessions/session-a/authority",
				"T4_BROWSER_STATE_DIR=/workspace/.t4/sessions/session-a/browser",
				"T4_CLUSTER_SERVER_SERVICE_ACCOUNT=t4-cluster-server",
				"T4_KUBERNETES_TOKEN_PATH="+filepath.Join(projection, "token"),
				"T4_KUBERNETES_CA_PATH="+filepath.Join(projection, "ca.crt"),
				"T4_KUBERNETES_NAMESPACE_PATH="+filepath.Join(projection, "namespace"),
				"T4_OMP_CONFIG_SOURCE_DIR="+source,
				"T4_TEST_XVFB_MARKER="+marker,
			)
			output, err := command.CombinedOutput()
			exitError, ok := err.(*exec.ExitError)
			if !ok || exitError.ExitCode() != 64 {
				t.Fatalf("entrypoint exit = %v, want code 64; output=%s", err, output)
			}
			if !strings.Contains(string(output), `"condition":"`+test.condition+`"`) {
				t.Fatalf("entrypoint output lacks bounded failure condition %q: %s", test.condition, output)
			}
			if _, err := os.Stat(marker); !os.IsNotExist(err) {
				t.Fatalf("Xvfb started before OMP configuration passed validation: %v", err)
			}
		})
	}
}

func helmTemplate(t *testing.T, extra ...string) string {
	t.Helper()
	return helmTemplateRelease(t, "release-name", extra...)
}

func helmTemplateRelease(t *testing.T, releaseName string, extra ...string) string {
	t.Helper()
	args := []string{"template", releaseName, filepath.Join(repoRoot(t), "deploy", "charts", "t4-cluster"), "--namespace", "t4-system"}
	args = append(args, extra...)
	command := exec.Command("helm", args...)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("helm %s: %v\n%s", strings.Join(args, " "), err, output)
	}
	return string(output)
}
func helmTemplateMustFail(t *testing.T, extra ...string) {
	t.Helper()
	args := []string{"template", "release-name", filepath.Join(repoRoot(t), "deploy", "charts", "t4-cluster"), "--namespace", "t4-system"}
	args = append(args, extra...)
	command := exec.Command("helm", args...)
	if output, err := command.CombinedOutput(); err == nil {
		t.Fatalf("helm unexpectedly accepted invalid values: %s", output)
	}
}

func enabledValues() []string {
	return []string{
		"--set", "enabled=true",
		"--set", "storage.adminRWXStorageClass=portable-rwx",
		"--set", "images.controller.digest=" + fakeDigest,
		"--set", "images.server.digest=" + fakeDigest,
		"--set", "images.sessionRuntime.digest=" + fakeDigest,
		"--set", "server.trustedProxyCIDRs[0]=192.0.2.0/24",
		"--set", "session.omp.configMap=omp-runtime-config",
		"--set", "session.omp.modelsKey=provider-models",
		"--set", "session.omp.settingsKey=agent-settings",
	}
}

func repoRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", "..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	return root
}

func mustRead(t *testing.T, path string) string {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func assertContains(t *testing.T, value string, required ...string) {
	t.Helper()
	for _, item := range required {
		if !strings.Contains(value, item) {
			t.Fatalf("output lacks %q", item)
		}
	}
}

func assertCount(t *testing.T, value, needle string, want int) {
	t.Helper()
	if got := strings.Count(value, needle); got != want {
		t.Fatalf("count(%q) = %d, want %d", needle, got, want)
	}
}

func assertKindCount(t *testing.T, rendered, kind string, want int) {
	t.Helper()
	needle := "kind: " + kind
	got := 0
	for _, line := range strings.Split(rendered, "\n") {
		if line == needle {
			got++
		}
	}
	if got != want {
		t.Fatalf("kind %q count = %d, want %d", kind, got, want)
	}
}

func documentContaining(t *testing.T, rendered, needle string) string {
	t.Helper()
	for _, document := range strings.Split(rendered, "\n---") {
		if strings.Contains(document, "kind: Role\n") && strings.Contains(document, needle) {
			return document
		}
	}
	t.Fatalf("no rendered document contains %q", needle)
	return ""
}

func documentContainingKind(t *testing.T, rendered, kind, needle string) string {
	t.Helper()
	for _, document := range strings.Split(rendered, "\n---") {
		if strings.Contains(document, "kind: "+kind+"\n") && strings.Contains(document, needle) {
			return document
		}
	}
	t.Fatalf("no rendered %s contains %q", kind, needle)
	return ""
}
