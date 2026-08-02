package charttests

import (
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
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
	assertCount(t, output, "apiVersion: apps/v1\nkind: Deployment", 2)
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
		"name: T4_PUBLIC_REST_BASE_URL",
		"value: \"https://omp.example.test/v1\"",
		"name: T4_PUBLIC_OMP_APP_WEBSOCKET_URL",
		"value: \"wss://omp.example.test/v1/ws\"",
		"name: T4_BUILD_REVISION",
		"value: \"fixture-revision\"",
		"name: T4_ADMISSION_MAX_ACTIVE_RUNTIMES",
		"value: \"10\"",
		"name: T4_ADMISSION_BROWSER_ENABLED",
		"value: \"false\"",
		"name: T4_ADMISSION_MAX_GPU_UNITS",
		"value: \"0\"",
		"name: T4_ADMISSION_CREATION_BURST",
		"value: \"10\"",
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

func TestIdentityAdaptersUseOnlyExplicitReferencedConfiguration(t *testing.T) {
	output := helmTemplate(t, append(enabledValues(),
		"--set-string", "server.identity.adapters[0]=oidc",
		"--set-string", "server.identity.adapters[1]=mtls",
		"--set-string", "server.identity.configMapRef.name=cluster-request-identity",
		"--set-string", "server.identity.configMapRef.key=adapters.json",
		"--set-string", "networkPolicy.identityProviderCIDRs[0]=203.0.113.24/32",
	)...)
	server := documentContainingKind(t, output, "Deployment", "name: \"release-name-t4-cluster-server\"")
	assertContains(t, server,
		"name: T4_CLUSTER_IDENTITY_CONFIG_FILE",
		"value: /var/run/t4-identity/config.json",
		"name: request-identity",
		"name: \"cluster-request-identity\"",
		"key: \"adapters.json\"",
		"path: config.json",
		"readOnly: true",
	)
	if strings.Contains(server, "name: T4_CLUSTER_IDENTITY_PROVIDER") {
		t.Fatal("legacy identity provider remained enabled beside referenced adapter configuration")
	}
	identityEgress := documentContainingKind(t, output, "NetworkPolicy", "name: \"release-name-t4-cluster-server-egress\"")
	assertContains(t, identityEgress, "203.0.113.24/32", "port: 443")
	helmTemplateMustFail(t, append(enabledValues(),
		"--set-string", "server.identity.adapters[0]=oidc",
	)...)
	helmTemplateMustFail(t, append(enabledValues(),
		"--set-string", "server.identity.configMapRef.name=identity-config",
		"--set-string", "server.identity.secretRef.name=identity-secret",
	)...)
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
		"session-token-reviewer",
		"session-access-manager",
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

func TestSSHGatewayUsesStableSecretsStrictDispatchAndHA(t *testing.T) {
	values := append(enabledValues(),
		"--set", "sshGateway.enabled=true",
		"--set", "images.sshGateway.digest="+fakeDigest,
		"--set-string", "sshGateway.existingHostKeySecret=ssh-host-key",
		"--set-string", "sshGateway.existingAuthorizedKeysSecret=ssh-authorized-keys",
		"--set-string", "networkPolicy.sshIngressCIDRs[0]=198.51.100.0/24",
		"--set", "sshGateway.commands.provider=true",
		"--set-string", "sshGateway.handlerModule=@t4-code/cluster-ssh-handler",
		"--set-string", "sshGateway.existingProviderAssertionSecret=provider-assertion",
		"--set-string", "sshGateway.providerInternalWebSocketURL=wss://provider.example.test:9443/internal/provider",
		"--set-string", "networkPolicy.sshBackendCIDRs[0]=203.0.113.0/24",
		"--set", "networkPolicy.sshBackendPorts[0]=9443",
	)
	output := helmTemplate(t, values...)
	assertKindCount(t, output, "Deployment", 3)
	gateway := documentContainingKind(t, output, "Deployment", "name: \"release-name-t4-cluster-ssh-gateway\"")
	assertContains(t, gateway,
		"replicas: 3",
		"maxUnavailable: 0",
		"image: \"ghcr.io/lycaonllc/t4-ssh-gateway@"+fakeDigest+"\"",
		"containerPort: 2222",
		"readOnlyRootFilesystem: true",
		"allowPrivilegeEscalation: false",
		"secretName: \"ssh-host-key\"",
		"secretName: \"ssh-authorized-keys\"",
		"defaultMode: 0400",
		"defaultMode: 0444",
		"name: T4_SSH_GATEWAY_HANDLER_MODULE",
		"name: T4_SSH_GATEWAY_ENABLE_PROVIDER",
		"name: T4_SSH_GATEWAY_ENABLE_RELAY",
		"name: T4_SSH_GATEWAY_ENABLE_ATTACH",
		"name: T4_SSH_GATEWAY_ENABLE_VERSION",
	)
	assertContains(t, gateway,
		"name: T4_PROVIDER_INTERNAL_HMAC_FILE",
		"/var/run/secrets/t4-provider-assertion/keyring.json",
		"secretName: \"provider-assertion\"",
		"key: \"keyring.json\"",
		"path: keyring.json",
		"wss://provider.example.test:9443/internal/provider",
	)
	server := documentContainingKind(t, output, "Deployment", "name: \"release-name-t4-cluster-server\"")
	assertContains(t, server,
		"name: T4_PROVIDER_INTERNAL_AUDIENCE",
		"provider.example.test:9443/internal/provider",
		"/var/run/secrets/t4-provider-assertion/keyring.json",
	)
	service := documentContainingKind(t, output, "Service", "name: \"release-name-t4-cluster-ssh-gateway\"")
	assertContains(t, service, "type: LoadBalancer", "port: 22", "targetPort: ssh")
	networkPolicy := documentContainingKind(t, output, "NetworkPolicy", "name: \"release-name-t4-cluster-ssh-ingress\"")
	assertContains(t, networkPolicy, "cidr: \"198.51.100.0/24\"", "port: 2222")
	sshEgress := documentContainingKind(t, output, "NetworkPolicy", "name: \"release-name-t4-cluster-ssh-egress\"")
	assertContains(t, sshEgress,
		"app.kubernetes.io/component: ssh-gateway",
		"app.kubernetes.io/component: server",
		"cidr: \"203.0.113.0/24\"",
		"port: 8080",
		"port: 9443",
	)
	serverIngress := documentContainingKind(t, output, "NetworkPolicy", "name: \"release-name-t4-cluster-gateway-ingress\"")
	assertContains(t, serverIngress, "app.kubernetes.io/component: ssh-gateway", "port: 8080")

	root := repoRoot(t)
	sshdConfig := mustRead(t, filepath.Join(root, "cluster", "images", "ssh-gateway", "sshd_config"))
	assertContains(t, sshdConfig,
		"AuthenticationMethods publickey",
		"ExposeAuthInfo yes",
		"ForceCommand /usr/local/bin/bun /opt/t4/packages/ssh-gateway/src/bin.ts",
		"DisableForwarding yes",
		"PermitTTY yes",
	)
	entrypoint := mustRead(t, filepath.Join(root, "cluster", "images", "ssh-gateway", "entrypoint.sh"))
	if strings.Contains(entrypoint, "ssh-keygen") {
		t.Fatal("SSH gateway startup generates replica-local host identity")
	}
	if strings.Contains(entrypoint, "test ! -L") {
		t.Fatal("SSH gateway rejects Kubernetes atomic Secret projection symlinks")
	}
	assertContains(t, entrypoint, "readlink -f", "\"$resolved_root\"/*")
	assertContains(t, entrypoint, "test -s \"$host_key\"", "test -s \"$authorized_keys\"", "/usr/sbin/sshd -t")
}

func TestSSHGatewayRequiresStableIdentitySecrets(t *testing.T) {
	base := append(enabledValues(),
		"--set", "sshGateway.enabled=true",
		"--set", "images.sshGateway.digest="+fakeDigest,
	)
	helmTemplateMustFail(t, base...)
	helmTemplateMustFail(t, append(base,
		"--set-string", "sshGateway.existingHostKeySecret=ssh-host-key",
	)...)
}

func TestSSHGatewayRequiresBackendHandlerForOperationalCommands(t *testing.T) {
	base := append(enabledValues(),
		"--set", "sshGateway.enabled=true",
		"--set", "images.sshGateway.digest="+fakeDigest,
		"--set-string", "sshGateway.existingHostKeySecret=ssh-host-key",
		"--set-string", "sshGateway.existingAuthorizedKeysSecret=ssh-authorized-keys",
		"--set", "sshGateway.commands.provider=true",
	)
	helmTemplateMustFail(t, base...)
	output := helmTemplate(t, append(base,
		"--set-string", "sshGateway.handlerModule=@t4-code/cluster-ssh-handler",
		"--set-string", "sshGateway.existingProviderAssertionSecret=provider-assertion",
	)...)
	gateway := documentContainingKind(t, output, "Deployment", "name: \"release-name-t4-cluster-ssh-gateway\"")
	assertContains(t, gateway,
		"name: T4_SSH_GATEWAY_HANDLER_MODULE",
		"value: \"@t4-code/cluster-ssh-handler\"",
		"name: T4_SSH_GATEWAY_ENABLE_PROVIDER",
		"value: \"1\"",
		"name: T4_PROVIDER_INTERNAL_WS_URL",
		"value: \"ws://release-name-t4-cluster-server.t4-system.svc:8080/internal/provider\"",
		"name: T4_PROVIDER_INTERNAL_HMAC_FILE",
	)
}

func TestValuesSchemaRejectsUnsafeNamesProfilesCIDRsAndHalfSelectors(t *testing.T) {
	for name, values := range map[string][]string{
		"cluster host name":                  {"--set-string", "clusterHost.name=Bad_Name"},
		"storage class name":                 {"--set-string", "storage.adminRWXStorageClass=Bad_Name"},
		"runtime profile":                    {"--set-string", "clusterHost.runtimeProfiles[0]=-bad"},
		"Woodpecker Secret name":             {"--set-string", "woodpecker.existingSecret=Bad_Name", "--set-string", "woodpecker.configMap=woodpecker-config"},
		"Woodpecker ConfigMap name":          {"--set-string", "woodpecker.existingSecret=woodpecker-token", "--set-string", "woodpecker.configMap=Bad_Name"},
		"Woodpecker key":                     {"--set-string", "woodpecker.existingSecret=woodpecker-token", "--set-string", "woodpecker.configMap=woodpecker-config", "--set-string", "woodpecker.tokenKey=bad/key"},
		"Woodpecker audience":                {"--set-string", "woodpecker.serviceAccountAudience=/bad", "--set-string", "woodpecker.configMap=woodpecker-config"},
		"provider URL uppercase host":        {"--set-string", "sshGateway.providerInternalWebSocketURL=wss://Provider.Example/internal/provider"},
		"provider URL explicit default port": {"--set-string", "sshGateway.providerInternalWebSocketURL=wss://provider.example:443/internal/provider"},
		"IPv4 default route":                 {"--set-string", "server.trustedProxyCIDRs[0]=0.0.0.0/0"},
		"IPv6 default route":                 {"--set-string", "server.trustedProxyCIDRs[0]=::/0"},
		"build version leading whitespace":   {"--set-string", "server.publicApi.build.version= 0.1.33"},
		"build revision trailing whitespace": {"--set-string", "server.publicApi.build.revision=fixture-revision "},
		"negative active runtime quota":      {"--set", "server.admission.maxActiveRuntimes=-1"},
		"unsafe workspace capacity":          {"--set", "server.admission.maxWorkspaceCapacityBytes=9007199254740992"},
		"zero creation burst":                {"--set", "server.admission.creationRate.burst=0"},
		"unbounded retry after":              {"--set", "server.admission.creationRate.maximumRetryAfterSeconds=301"},
		"gateway half selector":              {"--set-string", "networkPolicy.gatewayIngress.namespaceSelector.matchLabels.scope=gateway"},
		"observability half selector":        {"--set-string", "networkPolicy.observability.podSelector.matchLabels.scope=metrics"},
		"OMP ConfigMap name":                 {"--set-string", "session.omp.configMap=Bad_Name"},
		"OMP models key":                     {"--set-string", "session.omp.modelsKey=bad/key"},
		"removed OMP credential Secret":      {"--set-string", "session.omp.credentialSecret=omp-runtime-credential"},
		"removed OMP credential key":         {"--set-string", "session.omp.credentialKey=MODEL_API_KEY"},
		"removed OMP auth mode":              {"--set", "session.omp.allowUnauthenticated=true"},
		"identical OMP projection keys":      {"--set-string", "session.omp.settingsKey=provider-models"},
		"model route port zero":              {"--set", "networkPolicy.modelRoutePorts[0]=0"},
		"model route port above TCP range":   {"--set", "networkPolicy.modelRoutePorts[0]=65536"},
		"duplicate model route port":         {"--set", "networkPolicy.modelRoutePorts[0]=19481", "--set", "networkPolicy.modelRoutePorts[1]=19481"},
		"noninteger model route port":        {"--set-string", "networkPolicy.modelRoutePorts[0]=https"},
		"model route half selector":          {"--set-string", "networkPolicy.modelRoute.namespaceSelector.matchLabels.scope=linkedin-bot"},
		"CI provider port zero":              {"--set", "networkPolicy.ciProviderPorts[0]=0"},
		"CI provider port above TCP range":   {"--set", "networkPolicy.ciProviderPorts[0]=65536"},
		"duplicate CI provider port":         {"--set", "networkPolicy.ciProviderPorts[0]=8080", "--set", "networkPolicy.ciProviderPorts[1]=8080"},
		"noninteger CI provider port":        {"--set-string", "networkPolicy.ciProviderPorts[0]=http"},
		"CI provider half selector":          {"--set-string", "networkPolicy.ciProvider.namespaceSelector.matchLabels.scope=linkedin-bot"},
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
	assertCount(t, output, "apiVersion: apps/v1\nkind: Deployment", 3)
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
	assertContains(t, gateway,
		"replicas: 2",
		"maxUnavailable: 0",
		"topologySpreadConstraints:",
		"podAntiAffinity:",
		"k3s-worker-02",
	)
	if strings.Contains(gateway, "kubernetes-api-access") || strings.Contains(gateway, "serviceAccountToken:") {
		t.Fatal("model gateway received a runtime or Kubernetes credential")
	}
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
	modelGatewayPDB := documentContainingKind(t, output, "PodDisruptionBudget", "name: \"release-name-t4-cluster-model-gateway\"")
	assertContains(t, modelGatewayPDB, "minAvailable: 2")
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
	assertContains(t, controllerRole, "persistentvolumeclaims", "pods", "services", "secrets", "serviceaccounts", "t4sessions/status", "leases")
	assertContains(t, controllerRole,
		"resources: [configmaps]",
		"resourceNames: [\"omp-runtime-config\"]",
		"verbs: [get]",
		"resources: [roles, rolebindings]",
		"verbs: [get, list, watch, create, update, patch, delete]",
	)
	assertContains(t, serverRole, "t4clusterhosts", "t4workspaces", "t4sessions", "create", "update", "delete", "list", "watch")
	assertContains(t, serverRole, "resources: [configmaps]", "verbs: [get, create, update]")
	if strings.Contains(serverRole, "secrets") || strings.Contains(serverRole, "persistentvolumeclaims") || strings.Contains(serverRole, "t4sessions/status") {
		t.Fatal("server role can read secrets or mutate controller-owned infrastructure/status")
	}
	if strings.Contains(output, "name: \"release-name-t4-cluster-session-writer\"") ||
		strings.Contains(output, "name: \"release-name-t4-cluster-session\"") {
		t.Fatal("chart retained static cross-session ServiceAccount or writer RBAC")
	}
	accessManager := documentContainingKind(t, output, "ClusterRole", "name: \"release-name-t4-cluster-session-access-manager\"")
	assertContains(t, accessManager, "resources: [clusterrolebindings]", "verbs: [get, create, delete]")
}
func TestControllerCanRevokeGenerationAuthAndReadFenceEvidence(t *testing.T) {
	output := helmTemplate(t, enabledValues()...)
	controllerRole := documentContainingKind(t, output, "Role", "name: \"release-name-t4-cluster-controller\"")
	assertContains(t, controllerRole, "resources: [pods, services, persistentvolumeclaims, secrets, serviceaccounts]", "create", "delete", "resources: [leases]")
	storageReader := documentContainingKind(t, output, "ClusterRole", "name: \"release-name-t4-cluster-storage-reader\"")
	assertContains(t, storageReader, "storageclasses", "volumeattachments", "persistentvolumes", "get", "list", "watch")
}

func TestChartUsesOnlyProjectedServiceAccountIdentityForInternalPeers(t *testing.T) {
	output := helmTemplate(t, enabledValues()...)
	assertKindCount(t, output, "ServiceAccount", 2)
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
		"name: T4_SESSION_TOKEN_REVIEWER_CLUSTER_ROLE",
		"value: \"release-name-t4-cluster-session-token-reviewer\"",
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

func TestRESTLifecycleCRDFieldsAreBoundedAndWorkspaceRetentionIsMutable(t *testing.T) {
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

	for _, validation := range retentionPolicy.XValidations {
		if validation.Rule == "self == oldSelf" {
			t.Fatal("spec.retentionPolicy must remain mutable for the REST lifecycle contract")
		}
	}
	workspaceSpec := crd.Spec.Versions[0].Schema.OpenAPIV3Schema.Properties["spec"]
	if publicID, ok := workspaceSpec.Properties["publicId"]; !ok || publicID.MaxLength == nil || *publicID.MaxLength != 128 {
		t.Fatal("workspace CRD lacks a bounded publicId")
	}
	owner := workspaceSpec.Properties["owner"]
	if owner.Pattern == "^[A-Za-z0-9][A-Za-z0-9._:@/-]*$" || !strings.Contains(owner.Pattern, `\x00`) {
		t.Fatalf("workspace owner schema does not admit bounded UTF-8 principals while excluding controls: %q", owner.Pattern)
	}

	raw = mustRead(t, filepath.Join(root, "deploy", "charts", "t4-cluster", "crds", "t4sessions.cluster.t4.dev.yaml"))
	if err := yaml.Unmarshal([]byte(raw), &crd); err != nil {
		t.Fatalf("decode session CRD: %v", err)
	}
	sessionSpec := crd.Spec.Versions[0].Schema.OpenAPIV3Schema.Properties["spec"]
	assertSchemaProperties := []string{"publicId", "publicHostProfileId", "desiredState", "browserPolicy", "idlePolicy", "cmuxSessionName"}
	for _, property := range assertSchemaProperties {
		if _, ok := sessionSpec.Properties[property]; !ok {
			t.Fatalf("session CRD lacks bounded REST lifecycle field spec.%s", property)
		}
	}
	publicProfile := sessionSpec.Properties["publicHostProfileId"]
	if publicProfile.MaxLength == nil || *publicProfile.MaxLength != 128 {
		t.Fatal("session CRD publicHostProfileId is not bounded to the REST opaque ID contract")
	}
	cmuxName := sessionSpec.Properties["cmuxSessionName"]
	if cmuxName.MaxLength == nil || *cmuxName.MaxLength != 63 || cmuxName.Pattern == "" {
		t.Fatal("session CRD cmuxSessionName is not bounded and validated")
	}
	sessionStatus := crd.Spec.Versions[0].Schema.OpenAPIV3Schema.Properties["status"]
	runtimeGeneration := sessionStatus.Properties["runtimeGeneration"]
	if runtimeGeneration.MaxLength == nil || *runtimeGeneration.MaxLength != 128 || runtimeGeneration.Pattern == "" {
		t.Fatal("session CRD runtimeGeneration is not bounded controller-owned status")
	}
}

func TestRuntimeStateStorageCRDsRemainAdditiveBoundedAndSeparated(t *testing.T) {
	root := repoRoot(t)
	load := func(name string) apiextensionsv1.CustomResourceDefinition {
		t.Helper()
		var crd apiextensionsv1.CustomResourceDefinition
		if err := yaml.Unmarshal([]byte(mustRead(t, filepath.Join(root, "deploy", "charts", "t4-cluster", "crds", name))), &crd); err != nil {
			t.Fatalf("decode %s: %v", name, err)
		}
		return crd
	}

	host := load("t4clusterhosts.cluster.t4.dev.yaml")
	hostSpec := host.Spec.Versions[0].Schema.OpenAPIV3Schema.Properties["spec"]
	profile, ok := hostSpec.Properties["runtimeStateStorageProfile"]
	if !ok || profile.Properties["storageClassName"].MaxLength == nil || profile.Properties["size"].MaxLength == nil {
		t.Fatal("host runtime-state storage profile is absent or unbounded")
	}
	positiveSizeOnly := false
	for _, validation := range profile.XValidations {
		positiveSizeOnly = positiveSizeOnly ||
			strings.Contains(validation.Rule, "quantity(self.size)") &&
				strings.Contains(validation.Rule, "isGreaterThan") &&
				strings.Contains(validation.Rule, "quantity('0')")
	}
	if !positiveSizeOnly {
		t.Fatal("chart CRD does not reject zero runtime-state storage size while admitting positive quantities")
	}
	if slices.Contains(hostSpec.Required, "runtimeStateStorageProfile") {
		t.Fatal("runtime-state storage profile is not additive for legacy hosts")
	}

	workspace := load("t4workspaces.cluster.t4.dev.yaml")
	workspaceSpec := workspace.Spec.Versions[0].Schema.OpenAPIV3Schema.Properties["spec"]
	workspaceStatus := workspace.Spec.Versions[0].Schema.OpenAPIV3Schema.Properties["status"]
	for _, field := range []string{"storageClassName", "restoreSnapshotRef"} {
		if _, ok := workspaceSpec.Properties[field]; !ok || slices.Contains(workspaceSpec.Required, field) {
			t.Fatalf("workspace spec.%s is absent or required", field)
		}
	}
	for _, field := range []string{"selectedStorageClassName", "filesystemRoot", "attachmentCount", "snapshotRef"} {
		if _, ok := workspaceStatus.Properties[field]; !ok {
			t.Fatalf("workspace status lacks infrastructure field %s", field)
		}
	}

	session := load("t4sessions.cluster.t4.dev.yaml")
	sessionSpec := session.Spec.Versions[0].Schema.OpenAPIV3Schema.Properties["spec"]
	sessionStatus := session.Spec.Versions[0].Schema.OpenAPIV3Schema.Properties["status"]
	if _, ok := sessionSpec.Properties["runtimeStateRestoreSnapshotRef"]; !ok || slices.Contains(sessionSpec.Required, "runtimeStateRestoreSnapshotRef") {
		t.Fatal("session runtime-state restore reference is absent or required")
	}
	for _, field := range []string{
		"runtimeGeneration", "generationSecretEpoch", "generationSecretName", "fenceState", "fencingPodUid", "fencingGeneration", "fencingVolumeIdentity",
		"runtimeStatePVCName", "runtimeStateVolumeIdentity", "runtimeStateStorageClassName", "runtimeStateCapacity", "runtimeStateFilesystemRoot", "runtimeStateSnapshotRef",
	} {
		property, ok := sessionStatus.Properties[field]
		if !ok || property.Type == "string" && property.MaxLength == nil && len(property.Enum) == 0 {
			t.Fatalf("session status field %s is absent or unbounded", field)
		}
	}

	for name, status := range map[string]apiextensionsv1.JSONSchemaProps{"workspace": workspaceStatus, "session": sessionStatus} {
		encoded, err := json.Marshal(status)
		if err != nil {
			t.Fatal(err)
		}
		for _, forbidden := range []string{"prompt", "transcript", "credential", "browserData", "browserProfile"} {
			if strings.Contains(strings.ToLower(string(encoded)), strings.ToLower(forbidden)) {
				t.Fatalf("%s status exposes forbidden data field %q", name, forbidden)
			}
		}
	}
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
		"c4d3ecdc35234d1aa470c3e1101d9a4ca45b64c5",
		"provenance/omp-runtime-v1.json",
		"t4-omp-authority/1",
		"session-entrypoint.sh",
		"chromium",
		"Xvfb",
	)
	assertContains(t, entrypoint, "/usr/local/lib/t4/session-host-main/session-host-main.js")
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
		"git fetch --depth=1 origin \"${omp_commit}\"",
		"git checkout --detach FETCH_HEAD",
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
		`[[ "${T4_WRITER_LEASE_PATH}" == "${root}/private/writer-lease" ]]`,
		`[[ "${T4_CMUX_SOCKET_MODE}" == "0660" ]]`,
		"T4_OMP_CONFIG_SOURCE_DIR",
		"unexpected_arguments",
		`[[ "$#" -eq 0 ]]`,
		`export HOME="${T4_OMP_HOME}"`,
		`export PI_CODING_AGENT_DIR="${T4_AUTHORITY_STATE_DIR}/agent"`,
		`export CMUX_STATE_DIR="${T4_CMUX_STATE_DIR}"`,
		`export CMUX_SOCKET_PATH="${T4_CMUX_SOCKET_PATH}"`,
		`acquire_writer_lease "${T4_WRITER_LEASE_PATH}"`,
		"writer_lease_live_duplicate",
		`install -m 0600 "${models_source}"`,
		`install -m 0600 "${settings_source}"`,
		`"${PI_CODING_AGENT_DIR}/models.yml"`,
		`"${PI_CODING_AGENT_DIR}/config.yml"`,
		`/usr/local/bin/bun /usr/local/lib/t4/assert-omp-credentials-absent.js`,
		"omp_credential_state_present",
	)
	if strings.Contains(entrypoint, "T4_CLUSTER_SERVER_SERVICE_ACCOUNT") || strings.Contains(entrypoint, "T4_KUBERNETES_TOKEN_PATH") {
		t.Fatal("authority entrypoint requires credential-sidecar Kubernetes identity")
	}
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
			bin := filepath.Join(root, "bin")
			for _, directory := range []string{source, bin} {
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
				"T4_RUNTIME_ID=runtime-session-a",
				"T4_RUNTIME_UID=runtime-resource-uid",
				"T4_SESSION_STATE_ID=runtime-session-a",
				"T4_RUNTIME_GENERATION=gen_abcdefghijklmnopqrstuvwx",
				"T4_SESSION_STATE_ROOT=/runtime-state/runtime-session-a",
				"T4_SESSION_NAME=session-a",
				"T4_AUTHORITY_STATE_DIR=/runtime-state/runtime-session-a/authority",
				"T4_CMUX_STATE_DIR=/runtime-state/runtime-session-a/cmux",
				"T4_BROWSER_STATE_DIR=/runtime-state/runtime-session-a/browser",
				"T4_ARTIFACT_ROOT=/runtime-state/runtime-session-a/artifacts",
				"T4_PRIVATE_RUNTIME_DIR=/runtime-state/runtime-session-a/private",
				"T4_OMP_HOME=/runtime-state/runtime-session-a/home",
				"T4_WRITER_LEASE_PATH=/runtime-state/runtime-session-a/private/writer-lease",
				"T4_HOST_RUNTIME_DIR=/run/t4/runtime-session-a",
				"T4_CMUX_SOCKET_PATH=/run/t4/runtime-session-a/cmux/c.sock",
				"T4_CMUX_SOCKET_MODE=0660",
				"T4_WORKSPACE_ROOT=/workspace",
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

func TestResilienceMatrixAndOptionalRuntimePrePull(t *testing.T) {
	output := helmTemplate(t, enabledValues()...)
	controllerPDB := documentContainingKind(t, output, "PodDisruptionBudget", "name: \"release-name-t4-cluster-controller\"")
	assertContains(t, controllerPDB, "maxUnavailable: 0", "app.kubernetes.io/component: controller")
	controllerDeployment := documentContainingKind(t, output, "Deployment", "name: \"release-name-t4-cluster-controller\"")
	assertContains(t, controllerDeployment, "replicas: 2", "maxUnavailable: 0", "maxSurge: 1", "minReadySeconds: 10", "topologySpreadConstraints:", "podAntiAffinity:")
	serverPDB := documentContainingKind(t, output, "PodDisruptionBudget", "name: \"release-name-t4-cluster-server\"")
	assertContains(t, serverPDB, "minAvailable: 2")
	serverHPA := documentContainingKind(t, output, "HorizontalPodAutoscaler", "name: \"release-name-t4-cluster-server\"")
	assertContains(t, serverHPA,
		"minReplicas: 3",
		"maxReplicas: 9",
		"averageUtilization: 70",
		"averageUtilization: 75",
		"stabilizationWindowSeconds: 300",
	)

	prePullOutput := helmTemplate(t, append(enabledValues(), "--set", "imagePrePull.enabled=true")...)
	prePull := documentContainingKind(t, prePullOutput, "DaemonSet", "name: \"release-name-t4-cluster-runtime-prepull\"")
	assertContains(t, prePull,
		"image: \"ghcr.io/lycaonllc/t4-session-runtime@"+fakeDigest+"\"",
		"automountServiceAccountToken: false",
		"readOnlyRootFilesystem: true",
		"k3s-worker-02",
	)
	if strings.Contains(prePull, "secretKeyRef:") || strings.Contains(prePull, "serviceAccountToken:") || strings.Contains(prePull, "hostPath:") {
		t.Fatal("runtime pre-pull DaemonSet received credentials or host storage")
	}
	helmTemplateMustFail(t, append(enabledValues(), "--set", "server.autoscaling.minReplicas=1")...)
	helmTemplateMustFail(t, append(enabledValues(), "--set", "server.autoscaling.minReplicas=9", "--set", "server.autoscaling.maxReplicas=3")...)
}

func TestSSHGatewayRendersEquivalentHAAndReadinessDrain(t *testing.T) {
	output := helmTemplate(t, append(enabledValues(),
		"--set", "sshGateway.enabled=true",
		"--set", "images.sshGateway.digest="+fakeDigest,
		"--set-string", "sshGateway.existingHostKeySecret=ssh-host-key",
		"--set-string", "sshGateway.existingAuthorizedKeysSecret=ssh-authorized-keys",
	)...)
	deployment := documentContainingKind(t, output, "Deployment", "name: \"release-name-t4-cluster-ssh-gateway\"")
	assertContains(t, deployment,
		"replicas: 3",
		"maxUnavailable: 0",
		"topologySpreadConstraints:",
		"podAntiAffinity:",
		"preStop:",
		"touch /run/sshd/draining",
		"test ! -e /run/sshd/draining",
		"k3s-worker-02",
	)
	pdb := documentContainingKind(t, output, "PodDisruptionBudget", "name: \"release-name-t4-cluster-ssh-gateway\"")
	assertContains(t, pdb, "minAvailable: 2")
	hpa := documentContainingKind(t, output, "HorizontalPodAutoscaler", "name: \"release-name-t4-cluster-ssh-gateway\"")
	assertContains(t, hpa, "minReplicas: 3", "maxReplicas: 9")
}

func TestPrometheusRulesCoverEveryActionableOperationalFailure(t *testing.T) {
	output := helmTemplate(t, append(enabledValues(), "--set", "observability.prometheusRule.enabled=true")...)
	rules := documentContainingKind(t, output, "PrometheusRule", "name: \"release-name-t4-cluster\"")
	alerts := []string{
		"OmperatorServerBelowQuorum",
		"OmperatorControllerLeaderAbsent",
		"OmperatorReconcileErrors",
		"OmperatorRuntimeStartFailures",
		"OmperatorRuntimeFenceFailures",
		"OmperatorStorageOperationFailures",
		"OmperatorProviderTicketFailures",
		"OmperatorProviderSnapshotFailures",
		"OmperatorGatewayErrorRate",
		"OmperatorGatewayNotReady",
		"OmperatorRuntimeNotReady",
		"OmperatorCmuxProtocolMismatch",
		"OmperatorOmpBridgeMismatch",
		"OmperatorBrowserStreamDroppedFrames",
		"OmperatorWakeTimeouts",
		"OmperatorDrainFailures",
	}
	for index, alert := range alerts {
		runbookID := "P5-05-RB-0" + strconv.Itoa(index+1)
		if index < 9 {
			runbookID = "P5-05-RB-00" + strconv.Itoa(index+1)
		}
		assertContains(t, rules, "alert: "+alert, "runbook_id: "+runbookID)
	}
	assertCount(t, rules, "severity:", len(alerts))
	assertCount(t, rules, "runbook_id:", len(alerts))
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
		"--set", "storage.runtimeStateStorageClass=portable-runtime-rwop",
		"--set", "storage.volumeSnapshotClass=portable-snapshots",
		"--set", "images.controller.digest=" + fakeDigest,
		"--set", "images.server.digest=" + fakeDigest,
		"--set", "images.sessionRuntime.digest=" + fakeDigest,
		"--set", "server.trustedProxyCIDRs[0]=192.0.2.0/24",
		"--set-string", "server.publicApi.restBaseURL=https://omp.example.test/v1",
		"--set-string", "server.publicApi.ompAppWebSocketURL=wss://omp.example.test/v1/ws",
		"--set-string", "server.publicApi.build.version=0.1.33",
		"--set-string", "server.publicApi.build.revision=fixture-revision",
		"--set-string", "server.publicApi.build.builtAt=2026-07-29T12:00:00Z",
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
