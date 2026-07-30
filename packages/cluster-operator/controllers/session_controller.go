package controllers

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"time"

	"gopkg.in/yaml.v3"
	coordinationv1 "k8s.io/api/coordination/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	storagev1 "k8s.io/api/storage/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	meta "k8s.io/apimachinery/pkg/api/meta"
	apiresource "k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	intstr "k8s.io/apimachinery/pkg/util/intstr"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/controller/controllerutil"
	"sigs.k8s.io/controller-runtime/pkg/handler"

	clusterv1alpha1 "github.com/wolfiesch/omperator/packages/cluster-operator/api/v1alpha1"
)

const (
	DefaultSessionTokenReviewerClusterRole       = "t4-cluster-session-token-reviewer"
	DefaultServerServiceAccount                  = "t4-cluster-server"
	DefaultKubernetesAPIAudience                 = "https://kubernetes.default.svc"
	SessionReviewerTokenExpirationSeconds  int64 = 3600
)

const (
	sessionHostRefIndexField              = "t4.session.spec.hostRef"
	sessionWorkspaceRefIndexField         = "t4.session.spec.workspaceRef"
	generationAuthKey                     = "key"
	generationAuthMountPath               = "/run/t4-generation-auth"
	writerLeaseGenerationAnnotation       = "cluster.t4.dev/runtime-generation"
	sessionIdleSinceAnnotation            = "cluster.t4.dev/idle-since"
	sessionIdleGenerationAnnotation       = "cluster.t4.dev/idle-generation"
	runtimeActivityPollInterval           = 5 * time.Second
	runtimeActivityMaxCount         int64 = 1_000_000
)

var errSessionResourceOwnershipConflict = errors.New("session resource ownership conflict")

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

func (r *SessionReconciler) loadOMPResourceVersions(ctx context.Context, namespace string) (ompResourceVersions, string, string, error) {
	reader := r.APIReader
	if reader == nil {
		reader = r.Client
	}
	var configMap corev1.ConfigMap
	if err := reader.Get(ctx, types.NamespacedName{Namespace: namespace, Name: r.OMPConfig.ConfigMapName}, &configMap); err != nil {
		if apierrors.IsNotFound(err) {
			return ompResourceVersions{}, "OMPConfigMapNotFound", "administrator-owned OMP ConfigMap does not exist", nil
		}
		return ompResourceVersions{}, "", "", err
	}
	if configMap.Data[r.OMPConfig.ModelsKey] == "" || configMap.Data[r.OMPConfig.SettingsKey] == "" {
		return ompResourceVersions{}, "OMPConfigMapInvalid", "administrator-owned OMP ConfigMap must contain nonempty models and settings keys", nil
	}
	if err := validateAuthNoneModelsYAML(configMap.Data[r.OMPConfig.ModelsKey]); err != nil {
		return ompResourceVersions{}, "OMPModelsAuthenticationUnsafe", "OMP models configuration must contain only auth-none providers and no embedded credential fields", nil
	}
	if err := validateCredentialFreeSettingsYAML(configMap.Data[r.OMPConfig.SettingsKey]); err != nil {
		return ompResourceVersions{}, "OMPSettingsAuthenticationUnsafe", "OMP settings configuration must not contain embedded credential fields", nil
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
		if character >= 'a' && character <= 'z' || character >= '0' && character <= '9' {
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
	case "apikey", "authheader", "authorization", "credential", "password", "secret", "token", "accesstoken", "xapikey", "headers":
		return true
	}
	for _, suffix := range []string{"apikey", "authheader", "authorization", "credential", "password", "secret", "token"} {
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
					if parsed, err := url.Parse(value.Value); err == nil && (parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "") {
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
	if providers == nil || providers.Kind != yaml.MappingNode || len(providers.Content) == 0 {
		return fmt.Errorf("models document must contain providers")
	}
	for index := 0; index+1 < len(providers.Content); index += 2 {
		provider := providers.Content[index+1]
		auth := mappingValue(provider, "auth")
		if provider.Kind != yaml.MappingNode || auth == nil || auth.Kind != yaml.ScalarNode || auth.Value != "none" {
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
		return "OMPReferencesMissing", "administrator-owned OMP ConfigMap and configuration keys are not configured"
	}
	if len(utilvalidation.IsDNS1123Subdomain(config.ConfigMapName)) != 0 ||
		len(config.ModelsKey) > 253 || !configMapKeyPattern.MatchString(config.ModelsKey) ||
		len(config.SettingsKey) > 253 || !configMapKeyPattern.MatchString(config.SettingsKey) ||
		config.ModelsKey == config.SettingsKey {
		return "OMPReferencesInvalid", "administrator-owned OMP configuration references are invalid"
	}
	return "", ""
}

func runtimeImageValidationFailure(image string) (string, string) {
	if image == "" {
		return "RuntimeImageMissing", "administrator-owned session runtime image is not configured"
	}
	digestSeparator := strings.Index(image, "@sha256:")
	if digestSeparator <= 0 || digestSeparator > 255 || !runtimeImagePattern.MatchString(image) {
		return "RuntimeImageInvalid", "administrator-owned session runtime image must be an exact repository@sha256 digest with 64 lowercase hexadecimal characters"
	}
	return "", ""
}

type RuntimeActivitySignals struct {
	Clients             int64 `json:"clients"`
	OMPTurns            int64 `json:"ompTurns"`
	OMPRetries          int64 `json:"ompRetries"`
	OMPCompactions      int64 `json:"ompCompactions"`
	BashCommands        int64 `json:"bashCommands"`
	Jobs                int64 `json:"jobs"`
	Tasks               int64 `json:"tasks"`
	Approvals           int64 `json:"approvals"`
	UIPending           int64 `json:"uiPending"`
	TerminalConnections int64 `json:"terminalConnections"`
	TerminalLeases      int64 `json:"terminalLeases"`
	BrowserPreviews     int64 `json:"browserPreviews"`
	BrowserLeases       int64 `json:"browserLeases"`
	GatewayUpstreams    int64 `json:"gatewayUpstreams"`
}

type RuntimeActivitySnapshot struct {
	SchemaVersion int                    `json:"schemaVersion"`
	Active        bool                   `json:"active"`
	Keepalive     bool                   `json:"keepalive"`
	Policy        string                 `json:"policy"`
	Signals       RuntimeActivitySignals `json:"signals"`
}

type RuntimeShutdownAck struct {
	SchemaVersion int    `json:"schemaVersion"`
	Generation    string `json:"generation"`
	Durable       bool   `json:"durable"`
	DurableAcks clusterv1alpha1.DurableComponentAcknowledgements `json:"durableAcks"`
}

type RuntimeLifecycleClient interface {
	Activity(context.Context, *clusterv1alpha1.T4Session, *corev1.Pod) (RuntimeActivitySnapshot, error)
	DrainIfIdle(context.Context, *clusterv1alpha1.T4Session, *corev1.Pod) (RuntimeShutdownAck, error)
	Quiesce(context.Context, *clusterv1alpha1.T4Session, *corev1.Pod) (RuntimeShutdownAck, error)
	Reopen(context.Context, *clusterv1alpha1.T4Session, *corev1.Pod) error
}
type KubernetesRuntimeLifecycleClient struct {
	Reader client.Reader
	Store  client.Client
	HTTP   *http.Client
}

func (lifecycle *KubernetesRuntimeLifecycleClient) request(
	ctx context.Context,
	session *clusterv1alpha1.T4Session,
	pod *corev1.Pod,
	operation string,
	output any,
) error {
	if lifecycle.Reader == nil || session.UID == "" || session.Status.RuntimeGeneration == "" ||
		session.Status.PodUID == "" || session.Status.PodUID != string(pod.UID) ||
		pod.Annotations[writerLeaseGenerationAnnotation] != session.Status.RuntimeGeneration {
		return errors.New("runtime lifecycle identity is stale")
	}
	var secret corev1.Secret
	if err := lifecycle.Reader.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: session.Status.GenerationSecretName}, &secret); err != nil {
		return err
	}
	key := secret.Data[generationAuthKey]
	if len(key) != 32 || !sessionExclusivelyOwnsResource(&secret, session) {
		return errors.New("runtime lifecycle credential is invalid")
	}
	body, err := json.Marshal(map[string]string{
		"expectedRuntimeUid": string(session.UID),
		"expectedGeneration": session.Status.RuntimeGeneration,
	})
	if err != nil {
		return err
	}
	requestCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	endpoint := fmt.Sprintf("http://%s.%s.svc:8788/internal/runtime/%s", SessionServiceName(session), session.Namespace, operation)
	request, err := http.NewRequestWithContext(requestCtx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("authorization", "Bearer "+base64.RawURLEncoding.EncodeToString(key))
	httpClient := lifecycle.HTTP
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	response, err := httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		_, _ = io.Copy(io.Discard, io.LimitReader(response.Body, 64*1024))
		return fmt.Errorf("runtime lifecycle request rejected with status %d", response.StatusCode)
	}
	decoder := json.NewDecoder(io.LimitReader(response.Body, 64*1024+1))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(output); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return errors.New("runtime lifecycle response contains trailing data")
	}
	return nil
}

func (lifecycle *KubernetesRuntimeLifecycleClient) Activity(
	ctx context.Context,
	session *clusterv1alpha1.T4Session,
	pod *corev1.Pod,
) (RuntimeActivitySnapshot, error) {
	var snapshot RuntimeActivitySnapshot
	if err := lifecycle.request(ctx, session, pod, "activity", &snapshot); err != nil {
		return RuntimeActivitySnapshot{}, err
	}
	ingress, err := readRuntimeIngress(ctx, lifecycle.Reader, session.Namespace, session.Spec.HostRef, session.Name, session.Status.RuntimeGeneration)
	if err != nil {
		return RuntimeActivitySnapshot{}, err
	}
	snapshot.Signals.GatewayUpstreams = int64(ingress.ActiveLeases)
	snapshot.Active = snapshot.Keepalive || snapshot.Policy == "keep-awake" ||
		snapshot.Signals.Clients > 0 || snapshot.Signals.OMPTurns > 0 || snapshot.Signals.OMPRetries > 0 ||
		snapshot.Signals.OMPCompactions > 0 || snapshot.Signals.BashCommands > 0 || snapshot.Signals.Jobs > 0 ||
		snapshot.Signals.Tasks > 0 || snapshot.Signals.Approvals > 0 || snapshot.Signals.UIPending > 0 ||
		snapshot.Signals.TerminalConnections > 0 || snapshot.Signals.TerminalLeases > 0 ||
		snapshot.Signals.BrowserPreviews > 0 || snapshot.Signals.BrowserLeases > 0 || snapshot.Signals.GatewayUpstreams > 0
	return snapshot, nil
}

func (lifecycle *KubernetesRuntimeLifecycleClient) drain(
	ctx context.Context,
	session *clusterv1alpha1.T4Session,
	pod *corev1.Pod,
	mode string,
) (RuntimeShutdownAck, error) {
	if lifecycle.Store == nil {
		return RuntimeShutdownAck{}, errors.New("runtime ingress store is unavailable")
	}
	ingress, err := mutateRuntimeIngress(ctx, lifecycle.Store, session.Namespace, session.Spec.HostRef, session.Name, session.Status.RuntimeGeneration, func(current runtimeIngressState) (runtimeIngressState, bool, error) {
		if mode == "idle" && current.ActiveLeases > 0 {
			return current, false, errors.New("runtime gateway ingress is active")
		}
		return runtimeIngressState{Open: false, Reopening: false, ActiveLeases: current.ActiveLeases}, current.Open || current.Reopening, nil
	})
	if err != nil {
		return RuntimeShutdownAck{}, err
	}
	reopen := true
	defer func() {
		if reopen {
			_, _ = mutateRuntimeIngress(context.WithoutCancel(ctx), lifecycle.Store, session.Namespace, session.Spec.HostRef, session.Name, session.Status.RuntimeGeneration, func(current runtimeIngressState) (runtimeIngressState, bool, error) {
				return runtimeIngressState{Open: true, Reopening: false, ActiveLeases: current.ActiveLeases}, !current.Open || current.Reopening, nil
			})
		}
	}()
	if mode == "explicit" {
		for ingress.ActiveLeases > 0 {
			select {
			case <-ctx.Done():
				return RuntimeShutdownAck{}, ctx.Err()
			case <-time.After(100 * time.Millisecond):
			}
			ingress, err = readRuntimeIngress(ctx, lifecycle.Reader, session.Namespace, session.Spec.HostRef, session.Name, session.Status.RuntimeGeneration)
			if err != nil {
				return RuntimeShutdownAck{}, err
			}
		}
	}
	var result struct {
		State       string                  `json:"state"`
		Activity    RuntimeActivitySnapshot `json:"activity"`
		ShutdownAck *RuntimeShutdownAck     `json:"shutdownAck,omitempty"`
	}
	operation := "drain"
	if mode == "explicit" {
		operation = "quiesce"
	}
	if err := lifecycle.request(ctx, session, pod, operation, &result); err != nil {
		return RuntimeShutdownAck{}, err
	}
	if result.State != "drained" || result.ShutdownAck == nil || result.Activity.Active {
		return RuntimeShutdownAck{}, fmt.Errorf("runtime %s refused in state %q", operation, result.State)
	}
	reopen = false
	return *result.ShutdownAck, nil
}

func (lifecycle *KubernetesRuntimeLifecycleClient) DrainIfIdle(ctx context.Context, session *clusterv1alpha1.T4Session, pod *corev1.Pod) (RuntimeShutdownAck, error) {
	return lifecycle.drain(ctx, session, pod, "idle")
}
func (lifecycle *KubernetesRuntimeLifecycleClient) Quiesce(ctx context.Context, session *clusterv1alpha1.T4Session, pod *corev1.Pod) (RuntimeShutdownAck, error) {
	return lifecycle.drain(ctx, session, pod, "explicit")
}

func (lifecycle *KubernetesRuntimeLifecycleClient) Reopen(
	ctx context.Context,
	session *clusterv1alpha1.T4Session,
	pod *corev1.Pod,
) error {
	if lifecycle.Store == nil {
		return errors.New("runtime ingress store is unavailable")
	}
	if _, err := mutateRuntimeIngress(ctx, lifecycle.Store, session.Namespace, session.Spec.HostRef, session.Name, session.Status.RuntimeGeneration, func(current runtimeIngressState) (runtimeIngressState, bool, error) {
		return runtimeIngressState{Open: false, Reopening: true, ActiveLeases: current.ActiveLeases}, current.Open || !current.Reopening, nil
	}); err != nil {
		return fmt.Errorf("prepare shared runtime ingress reopen: %w", err)
	}
	var result struct {
		State      string `json:"state"`
		Generation string `json:"generation"`
	}
	if err := lifecycle.request(ctx, session, pod, "reopen", &result); err != nil {
		return err
	}
	if (result.State != "reopened" && result.State != "already_reopened") || result.Generation != session.Status.RuntimeGeneration {
		return fmt.Errorf("runtime reopen refused in state %q", result.State)
	}
	_, err := mutateRuntimeIngress(ctx, lifecycle.Store, session.Namespace, session.Spec.HostRef, session.Name, session.Status.RuntimeGeneration, func(current runtimeIngressState) (runtimeIngressState, bool, error) {
		return runtimeIngressState{Open: true, Reopening: false, ActiveLeases: current.ActiveLeases}, !current.Open || current.Reopening, nil
	})
	return err
}

func (activity RuntimeActivitySnapshot) valid() bool {
	counts := []int64{
		activity.Signals.Clients, activity.Signals.OMPTurns, activity.Signals.OMPRetries,
		activity.Signals.OMPCompactions, activity.Signals.BashCommands, activity.Signals.Jobs,
		activity.Signals.Tasks, activity.Signals.Approvals, activity.Signals.UIPending,
		activity.Signals.TerminalConnections, activity.Signals.TerminalLeases,
		activity.Signals.BrowserPreviews, activity.Signals.BrowserLeases, activity.Signals.GatewayUpstreams,
	}
	derived := activity.Keepalive || activity.Policy == "keep-awake"
	if activity.SchemaVersion != 1 || (activity.Policy != "allow-idle-sleep" && activity.Policy != "keep-awake") {
		return false
	}
	for _, count := range counts {
		if count < 0 || count > runtimeActivityMaxCount {
			return false
		}
		derived = derived || count > 0
	}
	return activity.Active == derived
}
type SessionReconciler struct {
	client.Client
	Scheme                              *runtime.Scheme
	APIReader                           client.Reader
	RuntimeImage                        string
	SessionTokenReviewerClusterRoleName string
	ServerServiceAccountName            string
	KubernetesAPIAudience               string
	OMPConfig                           SessionOMPConfig
	ExcludedNodeNames                   []string
	Resources                           corev1.ResourceRequirements
	SharedMemorySize                    apiresource.Quantity
	TemporarySize                       apiresource.Quantity
	RuntimeLifecycle                    RuntimeLifecycleClient
	Now                                 func() time.Time
	RuntimeActivityPollInterval         time.Duration
}

func (r *SessionReconciler) now() time.Time {
	if r.Now != nil {
		return r.Now().UTC()
	}
	return time.Now().UTC()
}
func (r *SessionReconciler) activityPollInterval() time.Duration {
	if r.RuntimeActivityPollInterval >= time.Second && r.RuntimeActivityPollInterval <= 30*time.Second {
		return r.RuntimeActivityPollInterval
	}
	return runtimeActivityPollInterval
}

func (r *SessionReconciler) reconcileIdleSleep(
	ctx context.Context,
	session *clusterv1alpha1.T4Session,
	pod *corev1.Pod,
) (ctrl.Result, bool, error) {
	pollInterval := r.activityPollInterval()
	policy := session.Spec.IdlePolicy
	if policy == nil || !policy.Enabled {
		return ctrl.Result{}, false, nil
	}
	if policy.IdleSeconds == nil || *policy.IdleSeconds < 60 || r.RuntimeLifecycle == nil {
		return ctrl.Result{RequeueAfter: pollInterval}, true, nil
	}
	activity, err := r.RuntimeLifecycle.Activity(ctx, session, pod)
	if err != nil || !activity.valid() {
		return ctrl.Result{RequeueAfter: pollInterval}, true, nil
	}
	if pod.Annotations == nil {
		pod.Annotations = map[string]string{}
	}
	clearIdle := func() error {
		if pod.Annotations[sessionIdleSinceAnnotation] == "" && pod.Annotations[sessionIdleGenerationAnnotation] == "" {
			return nil
		}
		delete(pod.Annotations, sessionIdleSinceAnnotation)
		delete(pod.Annotations, sessionIdleGenerationAnnotation)
		return r.Update(ctx, pod)
	}
	if activity.Active {
		if err := clearIdle(); err != nil {
			return ctrl.Result{}, true, err
		}
		return ctrl.Result{RequeueAfter: pollInterval}, true, nil
	}
	now := r.now()
	idleSince, parseErr := time.Parse(time.RFC3339Nano, pod.Annotations[sessionIdleSinceAnnotation])
	if parseErr != nil || pod.Annotations[sessionIdleGenerationAnnotation] != session.Status.RuntimeGeneration || idleSince.After(now) {
		pod.Annotations[sessionIdleSinceAnnotation] = now.Format(time.RFC3339Nano)
		pod.Annotations[sessionIdleGenerationAnnotation] = session.Status.RuntimeGeneration
		if err := r.Update(ctx, pod); err != nil {
			return ctrl.Result{}, true, err
		}
		return ctrl.Result{RequeueAfter: time.Duration(*policy.IdleSeconds) * time.Second}, true, nil
	}
	remaining := time.Duration(*policy.IdleSeconds)*time.Second - now.Sub(idleSince)
	if remaining > 0 {
		if remaining > pollInterval {
			remaining = pollInterval
		}
		return ctrl.Result{RequeueAfter: remaining}, true, nil
	}
	ack, err := r.RuntimeLifecycle.DrainIfIdle(ctx, session, pod)
	if err != nil {
		observeDrain(err)
		return ctrl.Result{RequeueAfter: pollInterval}, true, nil
	}
	if ack.SchemaVersion != 1 || !ack.Durable || ack.Generation != session.Status.RuntimeGeneration {
		observeDrain(errors.New("runtime drain acknowledgement is invalid"))
		return ctrl.Result{RequeueAfter: pollInterval}, true, nil
	}
	observeDrain(nil)
	expectedGeneration := session.Generation + 1
	session.Spec.DesiredState = clusterv1alpha1.DesiredStateSleeping
	if updateErr := r.Update(ctx, session); updateErr != nil {
		reconcileCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 5*time.Second)
		defer cancel()
		reader := client.Reader(r.Client)
		if r.APIReader != nil {
			reader = r.APIReader
		}
		var authoritative clusterv1alpha1.T4Session
		if readErr := reader.Get(reconcileCtx, types.NamespacedName{Namespace: session.Namespace, Name: session.Name}, &authoritative); readErr != nil {
			return ctrl.Result{}, true, errors.Join(updateErr, fmt.Errorf("read auto-sleep update outcome: %w", readErr))
		}
		if authoritative.Spec.DesiredState == clusterv1alpha1.DesiredStateSleeping && authoritative.Generation == expectedGeneration {
			if retireErr := retireRuntimeActivationAdmission(reconcileCtx, r.Client, authoritative.Namespace, authoritative.Spec.HostRef, authoritative.Spec.PublicID, authoritative.Annotations[restScopeIDAnnotation]); retireErr != nil {
				return ctrl.Result{}, true, errors.Join(updateErr, fmt.Errorf("retire committed auto-sleep admission: %w", retireErr))
			}
			return ctrl.Result{Requeue: true}, true, nil
		}
		if authoritative.Spec.DesiredState != clusterv1alpha1.DesiredStateRunning {
			return ctrl.Result{}, true, errors.Join(updateErr, fmt.Errorf("auto-sleep update outcome is generation %d state %q", authoritative.Generation, authoritative.Spec.DesiredState))
		}
		if reopenErr := r.RuntimeLifecycle.Reopen(reconcileCtx, &authoritative, pod); reopenErr != nil {
			return ctrl.Result{}, true, errors.Join(updateErr, fmt.Errorf("reopen runtime after rejected auto-sleep update: %w", reopenErr))
		}
		return ctrl.Result{}, true, updateErr
	}
	if err := retireRuntimeActivationAdmission(ctx, r.Client, session.Namespace, session.Spec.HostRef, session.Spec.PublicID, session.Annotations[restScopeIDAnnotation]); err != nil {
		return ctrl.Result{}, true, fmt.Errorf("retire auto-sleep admission: %w", err)
	}
	return ctrl.Result{Requeue: true}, true, nil
}

func (r *SessionReconciler) prepareRequestedInactive(
	ctx context.Context,
	session *clusterv1alpha1.T4Session,
) (ctrl.Result, bool, error) {
	if r.RuntimeLifecycle == nil || session.Status.RuntimeGeneration == "" ||
		session.Status.FenceState == clusterv1alpha1.RuntimeFenceDrainRequired ||
		session.Status.FenceState == clusterv1alpha1.RuntimeFenceShutdownRequested {
		return ctrl.Result{}, false, nil
	}
	var pod corev1.Pod
	if err := r.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: SessionPodName(session)}, &pod); err != nil {
		if apierrors.IsNotFound(err) {
			return ctrl.Result{}, false, nil
		}
		return ctrl.Result{}, true, err
	}
	ack, err := r.RuntimeLifecycle.Quiesce(ctx, session, &pod)
	if err != nil {
		observeDrain(err)
		return ctrl.Result{RequeueAfter: r.activityPollInterval()}, true, nil
	}
	if ack.SchemaVersion != 1 || !ack.Durable || ack.Generation != session.Status.RuntimeGeneration {
		observeDrain(errors.New("runtime drain acknowledgement is invalid"))
		return ctrl.Result{RequeueAfter: r.activityPollInterval()}, true, nil
	}
	observeDrain(nil)
	if err := retireRuntimeActivationAdmission(ctx, r.Client, session.Namespace, session.Spec.HostRef, session.Spec.PublicID, session.Annotations[restScopeIDAnnotation]); err != nil {
		return ctrl.Result{}, true, fmt.Errorf("retire inactive runtime admission: %w", err)
	}
	return ctrl.Result{}, false, nil
}

func (r *SessionReconciler) Reconcile(ctx context.Context, request ctrl.Request) (result ctrl.Result, err error) {
	startedAt := time.Now()
	var session clusterv1alpha1.T4Session
	found := false
	startObserved := false
	fenceObserved := false
	defer func() {
		if errors.Is(err, errSessionResourceOwnershipConflict) {
			result = ctrl.Result{RequeueAfter: 30 * time.Second}
			err = nil
		}
		if startObserved {
			observeRuntimeStart(err, session.Status.Phase == clusterv1alpha1.InfrastructureFailed || session.Status.Phase == clusterv1alpha1.InfrastructureDegraded, startedAt)
		}
		if fenceObserved {
			observeRuntimeFence(err, session.Status.FenceState == clusterv1alpha1.RuntimeFenceUncertain, startedAt)
		}
		observeReconcile(metricKindSession, request.NamespacedName, string(session.Status.Phase), conditionObjectPresent(&session, found, err), err, startedAt)
	}()
	if err := r.Get(ctx, request.NamespacedName, &session); err != nil {
		return ctrl.Result{}, client.IgnoreNotFound(err)
	}
	found = true
	startObserved = (session.Spec.DesiredState == "" || session.Spec.DesiredState == clusterv1alpha1.DesiredStateRunning) && session.Status.Phase != clusterv1alpha1.InfrastructureReady
	fenceObserved = session.Status.FenceState == clusterv1alpha1.RuntimeFenceDrainRequired ||
		session.Status.FenceState == clusterv1alpha1.RuntimeFenceShutdownRequested ||
		session.Status.FenceState == clusterv1alpha1.RuntimeFenceVerifying ||
		session.Status.FenceState == clusterv1alpha1.RuntimeFenceUncertain
	if !session.DeletionTimestamp.IsZero() {
		return r.reconcileDelete(ctx, &session)
	}
	if controllerutil.AddFinalizer(&session, clusterv1alpha1.SessionFinalizer) {
		if err := r.Update(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
	}
	if err := r.ensureSessionLifecycleStatus(ctx, &session); err != nil {
		return ctrl.Result{}, err
	}
	desiredState := session.Spec.DesiredState
	if desiredState == "" {
		desiredState = clusterv1alpha1.DesiredStateRunning
	}
	if desiredState == clusterv1alpha1.DesiredStateSleeping || desiredState == clusterv1alpha1.DesiredStateStopped {
		if result, waiting, err := r.prepareRequestedInactive(ctx, &session); waiting || err != nil {
			return result, err
		}
		return r.reconcileInactive(ctx, &session, desiredState)
	}
	if desiredState != clusterv1alpha1.DesiredStateRunning {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, false, false, "RuntimeConfigured", "DesiredStateInvalid", "session desired state is not supported")
	}
	if reason, message := runtimeImageValidationFailure(r.RuntimeImage); reason != "" {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, false, false, "RuntimeConfigured", reason, message)
	}
	if reason, message := r.OMPConfig.validationFailure(); reason != "" {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, false, false, "RuntimeConfigured", reason, message)
	}

	var host clusterv1alpha1.T4ClusterHost
	if err := r.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: session.Spec.HostRef}, &host); err != nil {
		if apierrors.IsNotFound(err) {
			if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
				return ctrl.Result{}, err
			}
			return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, false, false, "HostReady", "HostNotFound", "referenced T4ClusterHost does not exist")
		}
		return ctrl.Result{}, err
	}
	if !hasString(host.Spec.RuntimeProfiles, session.Spec.RuntimeProfile) {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, true, false, "RuntimeConfigured", "RuntimeProfileNotAllowed", "runtime profile is not allowed by the referenced T4ClusterHost")
	}
	if gateErr := StorageCapabilitiesPermitRuntime(&host); gateErr != nil {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, true, false, "StorageReady", "StorageCapabilitiesUnavailable", gateErr.Error())
	}
	var storageClass storagev1.StorageClass
	if err := r.Get(ctx, types.NamespacedName{Name: host.Spec.StorageClassName}, &storageClass); err != nil {
		if apierrors.IsNotFound(err) {
			if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
				return ctrl.Result{}, err
			}
			return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, true, false, "WorkspaceReady", ReasonStorageClassNotFound, fmt.Sprintf("StorageClass %q selected by the referenced T4ClusterHost does not exist", host.Spec.StorageClassName))
		}
		return ctrl.Result{}, err
	}
	if !storageClassAllowsRWX(storageClass.Annotations) {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, true, false, "WorkspaceReady", ReasonStorageClassNotRWX, fmt.Sprintf("StorageClass %q selected by the referenced T4ClusterHost is not administrator-declared ReadWriteMany", host.Spec.StorageClassName))
	}
	var workspace clusterv1alpha1.T4Workspace
	if err := r.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: session.Spec.WorkspaceRef}, &workspace); err != nil {
		if apierrors.IsNotFound(err) {
			if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
				return ctrl.Result{}, err
			}
			return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, true, false, "WorkspaceReady", "WorkspaceNotFound", "referenced T4Workspace does not exist")
		}
		return ctrl.Result{}, err
	}
	if workspace.Spec.HostRef != session.Spec.HostRef {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, true, false, "WorkspaceReady", "HostMismatch", "session and workspace must reference the same T4ClusterHost")
	}
	if workspace.Status.PVCName == "" {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 5 * time.Second}, r.updateSessionFailure(ctx, &session, true, false, "WorkspaceReady", "PVCNotDeclared", "workspace controller has not declared a PVC")
	}
	if workspace.UID != "" && workspace.Status.PVCName != WorkspacePVCName(&workspace) {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, true, false, "WorkspaceReady", "PVCIdentityMismatch", "workspace status does not reference its deterministic PVC")
	}
	var pvc corev1.PersistentVolumeClaim
	if err := r.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: workspace.Status.PVCName}, &pvc); err != nil {
		if apierrors.IsNotFound(err) {
			if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
				return ctrl.Result{}, err
			}
			return ctrl.Result{RequeueAfter: 5 * time.Second}, r.updateSessionFailure(ctx, &session, true, false, "WorkspaceReady", "PVCNotFound", "workspace PVC does not exist")
		}
		return ctrl.Result{}, err
	}
	if workspace.UID != "" && !workspaceOwnsPVC(&workspace, &pvc) {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, true, false, "WorkspaceReady", "PVCOwnershipConflict", "workspace PVC identity or ownership is not authoritative")
	}
	if pvcStorageClassName(&pvc) != host.Spec.StorageClassName {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, true, false, "WorkspaceReady", ReasonStorageClassMismatch, fmt.Sprintf("workspace PVC uses StorageClass %q instead of host-selected %q", pvcStorageClassName(&pvc), host.Spec.StorageClassName))
	}
	if pvc.Status.Phase != corev1.ClaimBound || !pvcHasRWX(&pvc) {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 5 * time.Second}, r.updateSessionFailure(ctx, &session, true, false, "WorkspaceReady", "PVCNotBoundRWX", "workspace PVC must be Bound and ReadWriteMany before a session starts")
	}
	runtimeVersions, reason, message, err := r.loadOMPResourceVersions(ctx, session.Namespace)
	if err != nil {
		return ctrl.Result{}, err
	}
	if reason != "" {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, true, true, "RuntimeConfigured", reason, message)
	}
	reason, message, err = r.authoritativePVCValidation(ctx, &workspace, &pvc, host.Spec.StorageClassName)
	if err != nil {
		return ctrl.Result{}, err
	}
	if reason != "" {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, true, false, "WorkspaceReady", reason, message)
	}
	runtimeStatePVC, reason, message, err := r.reconcileRuntimeStatePVC(ctx, &session, &host)
	if err != nil {
		return ctrl.Result{}, err
	}
	if reason != "" {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		if err := r.clearRuntimeStateStatus(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, true, true, "RuntimeConfigured", reason, message)
	}
	if err := r.updateRuntimeStateStatus(ctx, &session, runtimeStatePVC); err != nil {
		return ctrl.Result{}, err
	}
	if err := r.preflightSessionChildOwnership(ctx, &session); err != nil {
		return ctrl.Result{}, err
	}
	prepared, err := r.prepareRunningGeneration(ctx, &session, runtimeStatePVC)
	if err != nil {
		return ctrl.Result{}, err
	}
	if !prepared {
		if session.Status.FenceState == clusterv1alpha1.RuntimeFenceUncertain {
			return ctrl.Result{}, nil
		}
		return ctrl.Result{RequeueAfter: time.Second}, nil
	}

	serviceName := SessionServiceName(&session)
	podName := SessionPodName(&session)
	labels := map[string]string{
		"app.kubernetes.io/name":    "t4-session-runtime",
		"app.kubernetes.io/part-of": "t4-cluster",
		"cluster.t4.dev/session":    podName,
	}
	desiredService := corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: serviceName, Namespace: session.Namespace, Labels: labels},
		Spec: corev1.ServiceSpec{
			Type: corev1.ServiceTypeClusterIP,
			Ports: []corev1.ServicePort{
				{Name: "host", Port: 8787, TargetPort: intstr.FromString("host"), Protocol: corev1.ProtocolTCP},
				{Name: "activity", Port: 8788, TargetPort: intstr.FromString("activity"), Protocol: corev1.ProtocolTCP},
			},
		},
	}
	if err := controllerutil.SetControllerReference(&session, &desiredService, r.Scheme); err != nil {
		return ctrl.Result{}, err
	}
	var service corev1.Service
	serviceKey := types.NamespacedName{Namespace: session.Namespace, Name: serviceName}
	if err := r.Get(ctx, serviceKey, &service); apierrors.IsNotFound(err) {
		service = desiredService
		if err := r.Create(ctx, &service); err != nil {
			if !apierrors.IsAlreadyExists(err) {
				return ctrl.Result{}, err
			}
			reader := r.APIReader
			if reader == nil {
				reader = r.Client
			}
			if err := reader.Get(ctx, serviceKey, &service); err != nil {
				return ctrl.Result{}, err
			}
		}
	} else if err != nil {
		return ctrl.Result{}, err
	}
	if !sessionExclusivelyOwnsResource(&service, &session) {
		if err := r.deleteOwnedSessionResourcesAfterVerifiedDependencies(ctx, &session, "ServiceOwnershipConflict", "deterministic session Service has an unexpected owner"); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
	} else if !serviceExposureIsInternal(&service) {
		if err := deleteWithPreconditions(ctx, r.Client, &service); err != nil && !apierrors.IsNotFound(err) {
			return ctrl.Result{}, err
		}
		if err := r.updateSessionPending(ctx, &session, "", serviceName, "ServiceExposureChanged", "session Service is being recreated with ClusterIP-only exposure"); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: time.Second}, nil
	} else if !reflect.DeepEqual(service.Spec.Selector, desiredService.Spec.Selector) || !reflect.DeepEqual(service.Spec.Ports, desiredService.Spec.Ports) || !reflect.DeepEqual(service.Labels, desiredService.Labels) {
		service.Spec.Selector = desiredService.Spec.Selector
		service.Spec.Ports = desiredService.Spec.Ports
		service.Labels = desiredService.Labels
		if err := r.Update(ctx, &service); err != nil {
			return ctrl.Result{}, err
		}
	}
	if err := r.ensureGenerationAuth(ctx, &session); err != nil {
		if errors.Is(err, errSessionResourceOwnershipConflict) {
			return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, true, true, "Available", "GenerationAuthOwnershipConflict", "deterministic generation-auth Secret has an unexpected owner")
		}
		return ctrl.Result{}, err
	}
	if err := r.ensureSessionAccess(ctx, &session); err != nil {
		if errors.Is(err, errSessionResourceOwnershipConflict) {
			return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, true, true, "Available", "SessionAccessOwnershipConflict", "deterministic session Kubernetes access has an unexpected owner or policy")
		}
		return ctrl.Result{}, err
	}
	if err := r.ensureWriterLease(ctx, &session); err != nil {
		if errors.Is(err, errSessionResourceOwnershipConflict) {
			return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, true, true, "Available", "WriterLeaseOwnershipConflict", "deterministic writer Lease has an unexpected owner")
		}
		return ctrl.Result{}, err
	}

	desiredPod, err := r.desiredPod(&session, workspace.Status.PVCName, runtimeStatePVC.Name, podName, labels, runtimeVersions)
	if err != nil {
		return ctrl.Result{}, err
	}
	if err := controllerutil.SetControllerReference(&session, &desiredPod, r.Scheme); err != nil {
		return ctrl.Result{}, err
	}
	var pod corev1.Pod
	podKey := types.NamespacedName{Namespace: session.Namespace, Name: podName}
	if err := r.Get(ctx, podKey, &pod); apierrors.IsNotFound(err) {
		reason, message, err := r.authoritativePVCValidation(ctx, &workspace, &pvc, host.Spec.StorageClassName)
		if err != nil {
			return ctrl.Result{}, err
		}
		if reason != "" {
			if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
				return ctrl.Result{}, err
			}
			return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, true, false, "WorkspaceReady", reason, message)
		}
		reason, message, err = r.authoritativeRuntimeStatePVCValidation(ctx, &session, runtimeStatePVC, host.Spec.RuntimeStateStorageProfile)
		if err != nil {
			return ctrl.Result{}, err
		}
		if reason != "" {
			if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
				return ctrl.Result{}, err
			}
			if err := r.clearRuntimeStateStatus(ctx, &session); err != nil {
				return ctrl.Result{}, err
			}
			return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, true, true, "RuntimeConfigured", reason, message)
		}
		pod = desiredPod
		if err := r.Create(ctx, &pod); err != nil {
			if !apierrors.IsAlreadyExists(err) {
				return ctrl.Result{}, err
			}
			reader := r.APIReader
			if reader == nil {
				reader = r.Client
			}
			if err := reader.Get(ctx, podKey, &pod); err != nil {
				return ctrl.Result{}, err
			}
		}
	} else if err != nil {
		return ctrl.Result{}, err
	}
	if !sessionExclusivelyOwnsResource(&pod, &session) {
		if err := r.deleteOwnedSessionResourcesAfterVerifiedDependencies(ctx, &session, "PodOwnershipConflict", "deterministic session Pod has an unexpected owner"); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
	} else if !labelsContain(pod.Labels, desiredPod.Labels) {
		if pod.Labels == nil {
			pod.Labels = map[string]string{}
		}
		for key, value := range desiredPod.Labels {
			pod.Labels[key] = value
		}
		if err := r.Update(ctx, &pod); err != nil {
			return ctrl.Result{}, err
		}
		if err := r.updateSessionPending(ctx, &session, podName, serviceName, "PodLabelsChanged", "session Pod selector labels are being restored"); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: time.Second}, nil
	} else if pod.Annotations[clusterv1alpha1.SessionPodSpecHashAnnotation] != desiredPod.Annotations[clusterv1alpha1.SessionPodSpecHashAnnotation] {
		if err := r.beginGenerationDrain(ctx, &session, &pod, &service, "PodSpecChanged", "session Pod requires replacement"); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: time.Second}, nil
	}

	if waiting, checkpointErr := r.reconcileCheckpoint(ctx, &session, &pod, &workspace, &pvc, runtimeStatePVC, &host); checkpointErr != nil {
		return ctrl.Result{}, checkpointErr
	} else if waiting {
		return ctrl.Result{RequeueAfter: 2 * time.Second}, nil
	}
	reason, message, err = r.authoritativePVCValidation(ctx, &workspace, &pvc, host.Spec.StorageClassName)
	if err != nil {
		return ctrl.Result{}, err
	}
	if reason != "" {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, true, false, "WorkspaceReady", reason, message)
	}
	reason, message, err = r.authoritativeRuntimeStatePVCValidation(ctx, &session, runtimeStatePVC, host.Spec.RuntimeStateStorageProfile)
	if err != nil {
		return ctrl.Result{}, err
	}
	if reason != "" {
		if err := r.deleteOwnedSessionResources(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		if err := r.clearRuntimeStateStatus(ctx, &session); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: 30 * time.Second}, r.updateSessionFailure(ctx, &session, true, true, "RuntimeConfigured", reason, message)
	}

	ready, readyReason, readyMessage, err := r.compositeRuntimeReady(ctx, &session, &pod, runtimeStatePVC)
	if err != nil {
		return ctrl.Result{}, err
	}
	if pod.Status.Phase == corev1.PodFailed {
		if err := r.beginGenerationDrain(ctx, &session, &pod, &service, "PodFailed", "failed session Pod requires a fenced replacement"); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: time.Second}, nil
	}
	routeSelector := map[string]string(nil)
	if ready {
		routeSelector = labels
	}
	if !reflect.DeepEqual(service.Spec.Selector, routeSelector) {
		service.Spec.Selector = routeSelector
		if err := r.Update(ctx, &service); err != nil {
			return ctrl.Result{}, err
		}
	}
	original := session.Status
	if session.Status.Conditions != nil {
		original.Conditions = append([]metav1.Condition(nil), session.Status.Conditions...)
	}
	session.Status.ObservedGeneration = session.Generation
	session.Status.PodName = podName
	session.Status.PodUID = string(pod.UID)
	session.Status.ServiceName = ""
	meta.SetStatusCondition(&session.Status.Conditions, condition("HostReady", metav1.ConditionTrue, "HostResolved", "referenced T4ClusterHost is available", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("WorkspaceReady", metav1.ConditionTrue, "PVCBoundRWX", "workspace PVC is Bound and ReadWriteMany", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("RuntimeConfigured", metav1.ConditionTrue, "OMPReferencesReady", "administrator-owned OMP runtime references are configured", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("Fenced", metav1.ConditionTrue, "FenceProven", "every older runtime generation is positively fenced", session.Generation))
	if ready {
		meta.SetStatusCondition(&session.Status.Conditions, condition("StorageReady", metav1.ConditionTrue, "CompositeProbeReady", "runtime-state storage is writable in the current composite probe", session.Generation))
	} else {
		meta.SetStatusCondition(&session.Status.Conditions, condition("StorageReady", metav1.ConditionUnknown, "CompositeProbePending", "runtime-state writeability is not separately projected before composite readiness", session.Generation))
	}
	meta.SetStatusCondition(&session.Status.Conditions, condition("TicketsRevoked", metav1.ConditionTrue, "NoTicketIssuer", "no Kubernetes ticket issuer exists before P2-06", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("GenerationAuthRevoked", metav1.ConditionFalse, "GenerationAuthActive", "current generation authentication remains active only for the current workload", session.Generation))
	if ready {
		session.Status.ServiceName = serviceName
		session.Status.Phase = clusterv1alpha1.InfrastructureReady
		meta.SetStatusCondition(&session.Status.Conditions, condition("RouteReady", metav1.ConditionTrue, "CompositeReadinessProven", "generation-bound service route is published", session.Generation))
		meta.SetStatusCondition(&session.Status.Conditions, condition("Available", metav1.ConditionTrue, "CompositeReady", "session runtime satisfied every authority readiness gate", session.Generation))
	} else {
		session.Status.Phase = clusterv1alpha1.InfrastructureStarting
		meta.SetStatusCondition(&session.Status.Conditions, condition("RouteReady", metav1.ConditionFalse, readyReason, readyMessage, session.Generation))
		meta.SetStatusCondition(&session.Status.Conditions, condition("Available", metav1.ConditionFalse, readyReason, readyMessage, session.Generation))
	}
	if !reflect.DeepEqual(original, session.Status) {
		if err := r.Status().Update(ctx, &session); err != nil {
			if ready {
				published := service.DeepCopy()
				published.Spec.Selector = nil
				withdrawErr := r.Update(ctx, published)
				if withdrawErr != nil {
					if getErr := r.authoritativeReader().Get(ctx, client.ObjectKeyFromObject(&service), published); getErr != nil {
						return ctrl.Result{}, fmt.Errorf("commit ready status: %w; withdraw read failed: %v", err, getErr)
					}
					published.Spec.Selector = nil
					withdrawErr = r.Update(ctx, published)
				}
				if withdrawErr != nil {
					return ctrl.Result{}, fmt.Errorf("commit ready status: %w; withdraw failed route: %v", err, withdrawErr)
				}
			}
			return ctrl.Result{}, err
		}
	}
	if !ready {
		return ctrl.Result{RequeueAfter: 5 * time.Second}, nil
	}
	if idleResult, handled, err := r.reconcileIdleSleep(ctx, &session, &pod); handled || err != nil {
		return idleResult, err
	}
	return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
}

func GenerationAuthSecretName(session *clusterv1alpha1.T4Session, generation string) string {
	sum := sha256.Sum256([]byte(generation))
	return stableName("t4-generation-auth-", session.Name, types.UID(fmt.Sprintf("%x", sum[:8])))
}

func volumeIdentity(volumeName string) string {
	if volumeName == "" {
		return ""
	}
	sum := sha256.Sum256([]byte(volumeName))
	return fmt.Sprintf("%x", sum[:])
}

func SessionWriterLeaseName(session *clusterv1alpha1.T4Session) string {
	return stableName("t4-writer-", session.Name, session.UID)
}

func SessionServiceAccountName(session *clusterv1alpha1.T4Session) string {
	return stableName("t4-session-", session.Name, session.UID)
}

func SessionWriterRoleName(session *clusterv1alpha1.T4Session) string {
	return stableName("t4-writer-role-", session.Name, session.UID)
}

func SessionWriterRoleBindingName(session *clusterv1alpha1.T4Session) string {
	return stableName("t4-writer-binding-", session.Name, session.UID)
}

func SessionTokenReviewBindingName(session *clusterv1alpha1.T4Session) string {
	return stableName("t4-token-review-", session.Name, session.UID)
}

func (r *SessionReconciler) authoritativeReader() client.Reader {
	if r.APIReader != nil {
		return r.APIReader
	}
	return r.Client
}

func (r *SessionReconciler) preflightSessionChildOwnership(ctx context.Context, session *clusterv1alpha1.T4Session) error {
	reader := r.authoritativeReader()
	var pod corev1.Pod
	if err := reader.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: SessionPodName(session)}, &pod); err == nil {
		if !sessionExclusivelyOwnsResource(&pod, session) {
			return r.deleteOwnedSessionResourcesAfterVerifiedDependencies(ctx, session, "PodOwnershipConflict", "deterministic session Pod has an unexpected owner")
		}
	} else if !apierrors.IsNotFound(err) {
		return err
	}
	var service corev1.Service
	if err := reader.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: SessionServiceName(session)}, &service); err == nil {
		if !sessionExclusivelyOwnsResource(&service, session) {
			return r.deleteOwnedSessionResourcesAfterVerifiedDependencies(ctx, session, "ServiceOwnershipConflict", "deterministic session Service has an unexpected owner")
		}
	} else if !apierrors.IsNotFound(err) {
		return err
	}
	return nil
}

func (r *SessionReconciler) prepareRunningGeneration(ctx context.Context, session *clusterv1alpha1.T4Session, pvc *corev1.PersistentVolumeClaim) (bool, error) {
	if session.Status.FenceState == clusterv1alpha1.RuntimeFenceUncertain {
		return false, nil
	}
	reader := r.authoritativeReader()
	var pod corev1.Pod
	err := reader.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: SessionPodName(session)}, &pod)
	if err == nil {
		if !sessionExclusivelyOwnsResource(&pod, session) {
			return false, errSessionResourceOwnershipConflict
		}
		if session.Status.GenerationSecretEpoch == session.Status.RuntimeGeneration &&
			session.Status.GenerationSecretName != "" && pod.DeletionTimestamp.IsZero() {
			var secret corev1.Secret
			secretErr := reader.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: session.Status.GenerationSecretName}, &secret)
			if secretErr == nil && validGenerationAuthSecret(&secret, session) {
				return true, nil
			}
			if secretErr != nil && !apierrors.IsNotFound(secretErr) {
				return false, secretErr
			}
		}
		var service corev1.Service
		_ = reader.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: SessionServiceName(session)}, &service)
		if err := r.beginGenerationDrain(ctx, session, &pod, &service, "GenerationReplacement", "existing workload must be fenced before a fresh runtime generation is allocated"); err != nil {
			return false, err
		}
		return false, nil
	}
	if !apierrors.IsNotFound(err) {
		return false, err
	}
	if session.Status.FenceState == clusterv1alpha1.RuntimeFenceShutdownRequested {
		if err := r.enterFenceVerifying(ctx, session); err != nil {
			return false, err
		}
	}
	if session.Status.GenerationSecretEpoch == session.Status.RuntimeGeneration &&
		session.Status.GenerationSecretName != "" &&
		session.Status.FenceState == clusterv1alpha1.RuntimeFenceProven &&
		session.Status.PodName == "" &&
		session.Status.FencingGeneration == "" &&
		session.Status.FencingPodUID == "" {
		return true, nil
	}
	if session.Status.GenerationSecretName != "" &&
		session.Status.FenceState == clusterv1alpha1.RuntimeFenceProven &&
		session.Status.FencingGeneration == "" &&
		session.Status.PodName != "" {
		var service corev1.Service
		_ = reader.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: SessionServiceName(session)}, &service)
		if err := r.beginGenerationDrain(ctx, session, &corev1.Pod{}, &service, "RuntimeLost", "lost workload credential and storage authority must be fenced before replacement"); err != nil {
			return false, err
		}
		return false, nil
	}
	proven, reason, message, err := r.positiveFenceProof(ctx, session, pvc)
	if err != nil {
		return false, err
	}
	if !proven {
		return false, r.publishFenceUncertain(ctx, session, reason, message)
	}
	generation, err := newRuntimeGeneration()
	if err != nil {
		return false, err
	}
	before := session.Status
	if session.Status.Conditions != nil {
		before.Conditions = append([]metav1.Condition(nil), session.Status.Conditions...)
	}
	session.Status.ObservedGeneration = session.Generation
	session.Status.RuntimeGeneration = generation
	session.Status.GenerationSecretEpoch = generation
	session.Status.GenerationSecretName = GenerationAuthSecretName(session, generation)
	session.Status.FenceState = clusterv1alpha1.RuntimeFenceProven
	session.Status.FencingPodUID = ""
	session.Status.FencingGeneration = ""
	session.Status.FencingVolumeIdentity = ""
	session.Status.PodName = ""
	session.Status.PodUID = ""
	session.Status.ServiceName = ""
	session.Status.Phase = clusterv1alpha1.InfrastructureProvisioning
	meta.SetStatusCondition(&session.Status.Conditions, condition("HostReady", metav1.ConditionTrue, "HostResolved", "referenced T4ClusterHost is available", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("WorkspaceReady", metav1.ConditionTrue, "PVCBoundRWX", "workspace PVC is Bound and ReadWriteMany", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("RuntimeConfigured", metav1.ConditionTrue, "OMPReferencesReady", "administrator-owned OMP runtime references are configured", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("Fenced", metav1.ConditionTrue, "FenceProven", "prior workload, writer lease, and runtime-state attachment are authoritatively absent", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("RouteReady", metav1.ConditionFalse, "GenerationAllocating", "route publication remains disabled while the fresh generation starts", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("StorageReady", metav1.ConditionUnknown, "GenerationAllocating", "runtime-state attachment waits for the fresh generation", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("TicketsRevoked", metav1.ConditionTrue, "NoTicketIssuer", "no Kubernetes ticket issuer exists before P2-06", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("GenerationAuthRevoked", metav1.ConditionTrue, "GenerationAuthNotCreated", "fresh generation authentication is not created until the generation CAS commits", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("Available", metav1.ConditionFalse, "GenerationAllocating", "fresh generation startup has not begun", session.Generation))
	if reflect.DeepEqual(before, session.Status) {
		return false, nil
	}
	// Status Update is the generation compare-and-swap: a resourceVersion
	// conflict aborts before Secret creation, storage attachment, or Pod start.
	if err := r.Status().Update(ctx, session); err != nil {
		return false, err
	}
	return true, nil
}

func validGenerationAuthSecret(secret *corev1.Secret, session *clusterv1alpha1.T4Session) bool {
	immutable := secret.Immutable != nil && *secret.Immutable
	value, found := secret.Data[generationAuthKey]
	return sessionExclusivelyOwnsResource(secret, session) &&
		secret.Annotations["cluster.t4.dev/runtime-generation"] == session.Status.RuntimeGeneration &&
		secret.Type == corev1.SecretTypeOpaque && immutable && found && len(value) == 32 && len(secret.Data) == 1
}

func (r *SessionReconciler) ensureGenerationAuth(ctx context.Context, session *clusterv1alpha1.T4Session) error {
	if session.Status.GenerationSecretEpoch != session.Status.RuntimeGeneration ||
		session.Status.GenerationSecretName == "" {
		return fmt.Errorf("runtime generation authentication decision is not committed")
	}
	key := types.NamespacedName{Namespace: session.Namespace, Name: session.Status.GenerationSecretName}
	var existing corev1.Secret
	if err := r.Get(ctx, key, &existing); err == nil {
		if !validGenerationAuthSecret(&existing, session) {
			return errSessionResourceOwnershipConflict
		}
		return nil
	} else if !apierrors.IsNotFound(err) {
		return err
	}
	var entropy [32]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		return fmt.Errorf("generate runtime generation authentication key: %w", err)
	}
	secret := corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name: session.Status.GenerationSecretName, Namespace: session.Namespace,
			Annotations: map[string]string{"cluster.t4.dev/runtime-generation": session.Status.RuntimeGeneration},
		},
		Immutable: ptr(true),
		Type:      corev1.SecretTypeOpaque,
		Data:      map[string][]byte{generationAuthKey: entropy[:]},
	}
	if err := controllerutil.SetControllerReference(session, &secret, r.Scheme); err != nil {
		return err
	}
	if err := r.Create(ctx, &secret); err != nil {
		if !apierrors.IsAlreadyExists(err) {
			return err
		}
		if err := r.authoritativeReader().Get(ctx, key, &existing); err != nil {
			return err
		}
		if !validGenerationAuthSecret(&existing, session) {
			return errSessionResourceOwnershipConflict
		}
	}
	return nil
}

func (r *SessionReconciler) ensureSessionAccess(ctx context.Context, session *clusterv1alpha1.T4Session) error {
	serviceAccountName := SessionServiceAccountName(session)
	leaseName := SessionWriterLeaseName(session)
	roleName := SessionWriterRoleName(session)
	serviceAccount := corev1.ServiceAccount{ObjectMeta: metav1.ObjectMeta{Name: serviceAccountName, Namespace: session.Namespace}, AutomountServiceAccountToken: ptr(false)}
	role := rbacv1.Role{
		ObjectMeta: metav1.ObjectMeta{Name: roleName, Namespace: session.Namespace},
		Rules: []rbacv1.PolicyRule{{
			APIGroups:     []string{"coordination.k8s.io"},
			Resources:     []string{"leases"},
			ResourceNames: []string{leaseName},
			Verbs:         []string{"get", "update"},
		}},
	}
	roleBinding := rbacv1.RoleBinding{
		ObjectMeta: metav1.ObjectMeta{Name: SessionWriterRoleBindingName(session), Namespace: session.Namespace},
		Subjects:   []rbacv1.Subject{{Kind: "ServiceAccount", APIGroup: "", Name: serviceAccountName, Namespace: session.Namespace}},
		RoleRef:    rbacv1.RoleRef{APIGroup: "rbac.authorization.k8s.io", Kind: "Role", Name: roleName},
	}
	for _, object := range []client.Object{&serviceAccount, &role, &roleBinding} {
		if err := controllerutil.SetControllerReference(session, object, r.Scheme); err != nil {
			return err
		}
	}
	if err := r.ensureSessionServiceAccount(ctx, session, &serviceAccount); err != nil {
		return err
	}
	if err := r.ensureSessionRole(ctx, session, &role); err != nil {
		return err
	}
	if err := r.ensureSessionRoleBinding(ctx, session, &roleBinding); err != nil {
		return err
	}
	reviewerRole := r.SessionTokenReviewerClusterRoleName
	if reviewerRole == "" {
		reviewerRole = DefaultSessionTokenReviewerClusterRole
	}
	tokenBinding := rbacv1.ClusterRoleBinding{
		ObjectMeta: metav1.ObjectMeta{
			Name: SessionTokenReviewBindingName(session),
			Annotations: map[string]string{
				"cluster.t4.dev/session-name":      session.Name,
				"cluster.t4.dev/session-namespace": session.Namespace,
				"cluster.t4.dev/session-uid":       string(session.UID),
			},
		},
		Subjects: []rbacv1.Subject{{Kind: "ServiceAccount", APIGroup: "", Name: serviceAccountName, Namespace: session.Namespace}},
		RoleRef:  rbacv1.RoleRef{APIGroup: "rbac.authorization.k8s.io", Kind: "ClusterRole", Name: reviewerRole},
	}
	var existing rbacv1.ClusterRoleBinding
	key := types.NamespacedName{Name: tokenBinding.Name}
	if err := r.authoritativeReader().Get(ctx, key, &existing); err == nil {
		if !reflect.DeepEqual(existing.Subjects, tokenBinding.Subjects) ||
			!reflect.DeepEqual(existing.RoleRef, tokenBinding.RoleRef) ||
			existing.Annotations["cluster.t4.dev/session-uid"] != string(session.UID) ||
			existing.Annotations["cluster.t4.dev/session-name"] != session.Name ||
			existing.Annotations["cluster.t4.dev/session-namespace"] != session.Namespace {
			return errSessionResourceOwnershipConflict
		}
		return nil
	} else if !apierrors.IsNotFound(err) {
		return err
	}
	if err := r.Create(ctx, &tokenBinding); err != nil {
		if apierrors.IsAlreadyExists(err) {
			return errSessionResourceOwnershipConflict
		}
		return err
	}
	return nil
}

func (r *SessionReconciler) ensureSessionServiceAccount(ctx context.Context, session *clusterv1alpha1.T4Session, desired *corev1.ServiceAccount) error {
	var existing corev1.ServiceAccount
	if err := r.authoritativeReader().Get(ctx, client.ObjectKeyFromObject(desired), &existing); err == nil {
		if !sessionExclusivelyOwnsResource(&existing, session) {
			return errSessionResourceOwnershipConflict
		}
		return nil
	} else if !apierrors.IsNotFound(err) {
		return err
	}
	if err := r.Create(ctx, desired); err != nil {
		if apierrors.IsAlreadyExists(err) {
			return errSessionResourceOwnershipConflict
		}
		return err
	}
	return nil
}

func (r *SessionReconciler) ensureSessionRole(ctx context.Context, session *clusterv1alpha1.T4Session, desired *rbacv1.Role) error {
	var existing rbacv1.Role
	if err := r.authoritativeReader().Get(ctx, client.ObjectKeyFromObject(desired), &existing); err == nil {
		if !sessionExclusivelyOwnsResource(&existing, session) || !reflect.DeepEqual(existing.Rules, desired.Rules) {
			return errSessionResourceOwnershipConflict
		}
		return nil
	} else if !apierrors.IsNotFound(err) {
		return err
	}
	if err := r.Create(ctx, desired); err != nil {
		if apierrors.IsAlreadyExists(err) {
			return errSessionResourceOwnershipConflict
		}
		return err
	}
	return nil
}

func (r *SessionReconciler) ensureSessionRoleBinding(ctx context.Context, session *clusterv1alpha1.T4Session, desired *rbacv1.RoleBinding) error {
	var existing rbacv1.RoleBinding
	if err := r.authoritativeReader().Get(ctx, client.ObjectKeyFromObject(desired), &existing); err == nil {
		if !sessionExclusivelyOwnsResource(&existing, session) ||
			!reflect.DeepEqual(existing.Subjects, desired.Subjects) ||
			!reflect.DeepEqual(existing.RoleRef, desired.RoleRef) {
			return errSessionResourceOwnershipConflict
		}
		return nil
	} else if !apierrors.IsNotFound(err) {
		return err
	}
	if err := r.Create(ctx, desired); err != nil {
		if apierrors.IsAlreadyExists(err) {
			return errSessionResourceOwnershipConflict
		}
		return err
	}
	return nil
}

func (r *SessionReconciler) ensureWriterLease(ctx context.Context, session *clusterv1alpha1.T4Session) error {
	key := types.NamespacedName{Namespace: session.Namespace, Name: SessionWriterLeaseName(session)}
	var existing coordinationv1.Lease
	if err := r.Get(ctx, key, &existing); err == nil {
		if !sessionExclusivelyOwnsResource(&existing, session) {
			return errSessionResourceOwnershipConflict
		}
		if existing.Annotations[writerLeaseGenerationAnnotation] == session.Status.RuntimeGeneration {
			return nil
		}
		if existing.Spec.HolderIdentity != nil && *existing.Spec.HolderIdentity != "" {
			return errSessionResourceOwnershipConflict
		}
		if existing.Annotations == nil {
			existing.Annotations = map[string]string{}
		}
		existing.Annotations[writerLeaseGenerationAnnotation] = session.Status.RuntimeGeneration
		return r.Update(ctx, &existing)
	} else if !apierrors.IsNotFound(err) {
		return err
	}
	lease := coordinationv1.Lease{ObjectMeta: metav1.ObjectMeta{Name: key.Name, Namespace: key.Namespace, Annotations: map[string]string{writerLeaseGenerationAnnotation: session.Status.RuntimeGeneration}}}
	if err := controllerutil.SetControllerReference(session, &lease, r.Scheme); err != nil {
		return err
	}
	if err := r.Create(ctx, &lease); err != nil && !apierrors.IsAlreadyExists(err) {
		return err
	}
	return nil
}

func (r *SessionReconciler) beginGenerationDrain(ctx context.Context, session *clusterv1alpha1.T4Session, pod *corev1.Pod, service *corev1.Service, reason, message string) error {
	if session.Status.FencingVolumeIdentity == "" && session.Status.RuntimeStateVolumeIdentity == "" &&
		session.Status.RuntimeStatePVCName != "" {
		var pvc corev1.PersistentVolumeClaim
		err := r.authoritativeReader().Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: session.Status.RuntimeStatePVCName}, &pvc)
		if err == nil {
			session.Status.RuntimeStateVolumeIdentity = volumeIdentity(pvc.Spec.VolumeName)
		} else if !apierrors.IsNotFound(err) {
			return err
		}
	}
	if session.Status.FencingVolumeIdentity == "" {
		session.Status.FencingVolumeIdentity = session.Status.RuntimeStateVolumeIdentity
	}
	if service.Name != "" && len(service.Spec.Selector) != 0 {
		service.Spec.Selector = nil
		if err := r.Update(ctx, service); err != nil {
			return err
		}
	}
	before := session.Status
	if session.Status.Conditions != nil {
		before.Conditions = append([]metav1.Condition(nil), session.Status.Conditions...)
	}
	session.Status.ObservedGeneration = session.Generation
	session.Status.ServiceName = ""
	session.Status.Phase = clusterv1alpha1.InfrastructurePending
	if reason == "Terminating" {
		session.Status.Phase = clusterv1alpha1.InfrastructureTerminating
	}
	session.Status.FenceState = clusterv1alpha1.RuntimeFenceDrainRequired
	session.Status.FencingGeneration = session.Status.RuntimeGeneration
	if pod.UID != "" {
		session.Status.FencingPodUID = string(pod.UID)
	} else if session.Status.FencingPodUID == "" {
		session.Status.FencingPodUID = session.Status.PodUID
	}
	meta.SetStatusCondition(&session.Status.Conditions, condition("HostReady", metav1.ConditionUnknown, "Draining", "host dependency is not authoritative during drain", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("WorkspaceReady", metav1.ConditionUnknown, "Draining", "workspace dependency is not authoritative during drain", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("RuntimeConfigured", metav1.ConditionUnknown, "Draining", "runtime configuration is not authoritative during drain", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("Fenced", metav1.ConditionUnknown, "DrainRequired", "writer fence proof follows ordered drain and shutdown", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("StorageReady", metav1.ConditionUnknown, "Draining", "runtime-state attachment fence is being established", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("RouteReady", metav1.ConditionFalse, "RouteDraining", "route publication and ticket minting are disabled before revocation", session.Generation))
	// P2-06 is the first Kubernetes ticket issuer. At P2-04 there are no
	// applicable Kubernetes tickets; RouteReady=False is the fail-closed
	// publication seam consumed by that issuer.
	meta.SetStatusCondition(&session.Status.Conditions, condition("TicketsRevoked", metav1.ConditionTrue, "NoTicketIssuer", "no Kubernetes ticket issuer exists before P2-06", session.Generation))
	if !reflect.DeepEqual(before, session.Status) {
		if err := r.Status().Update(ctx, session); err != nil {
			return err
		}
	}
	if session.Status.GenerationSecretName != "" {
		var secret corev1.Secret
		key := types.NamespacedName{Namespace: session.Namespace, Name: session.Status.GenerationSecretName}
		if err := r.authoritativeReader().Get(ctx, key, &secret); err == nil {
			if !sessionExclusivelyOwnsResource(&secret, session) {
				return r.publishFenceUncertain(ctx, session, "GenerationAuthOwnershipConflict", "deterministic generation-auth Secret has an unexpected owner")
			}
			if err := deleteWithPreconditions(ctx, r.Client, &secret); err != nil && !apierrors.IsNotFound(err) {
				return err
			}
		} else if !apierrors.IsNotFound(err) {
			return err
		}
	}
	before = session.Status
	if session.Status.Conditions != nil {
		before.Conditions = append([]metav1.Condition(nil), session.Status.Conditions...)
	}
	session.Status.FenceState = clusterv1alpha1.RuntimeFenceShutdownRequested
	meta.SetStatusCondition(&session.Status.Conditions, condition("GenerationAuthRevoked", metav1.ConditionTrue, "GenerationAuthDeleted", "generation-bound authentication is absent before workload termination", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("Available", metav1.ConditionFalse, reason, message, session.Generation))
	if !reflect.DeepEqual(before, session.Status) {
		if err := r.Status().Update(ctx, session); err != nil {
			return err
		}
	}

	if pod.Name != "" && pod.DeletionTimestamp.IsZero() {
		if err := deleteWithPreconditions(ctx, r.Client, pod); err != nil && !apierrors.IsNotFound(err) {
			return err
		}
	}
	return nil
}
func (r *SessionReconciler) enterFenceVerifying(ctx context.Context, session *clusterv1alpha1.T4Session) error {
	reader := r.authoritativeReader()
	var lease coordinationv1.Lease
	leaseKey := types.NamespacedName{Namespace: session.Namespace, Name: SessionWriterLeaseName(session)}
	if err := reader.Get(ctx, leaseKey, &lease); err == nil {
		if !sessionExclusivelyOwnsResource(&lease, session) {
			return r.publishFenceUncertain(ctx, session, "WriterLeaseOwnershipConflict", "deterministic writer Lease has an unexpected owner")
		}
		if err := deleteWithPreconditions(ctx, r.Client, &lease); err != nil && !apierrors.IsNotFound(err) {
			return err
		}
	} else if !apierrors.IsNotFound(err) {
		return err
	}
	before := session.Status
	if session.Status.Conditions != nil {
		before.Conditions = append([]metav1.Condition(nil), session.Status.Conditions...)
	}
	session.Status.FenceState = clusterv1alpha1.RuntimeFenceVerifying
	meta.SetStatusCondition(&session.Status.Conditions, condition("Fenced", metav1.ConditionUnknown, "FenceVerifying", "authoritative Pod, route, generation authentication, Lease, and VolumeAttachment evidence is being evaluated", session.Generation))
	if reflect.DeepEqual(before, session.Status) {
		return nil
	}
	return r.Status().Update(ctx, session)
}

func (r *SessionReconciler) positiveFenceProof(ctx context.Context, session *clusterv1alpha1.T4Session, pvc *corev1.PersistentVolumeClaim) (bool, string, string, error) {
	reader := r.authoritativeReader()
	_ = pvc
	var pod corev1.Pod
	err := reader.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: SessionPodName(session)}, &pod)
	if err == nil {
		if session.Status.FencingPodUID == "" || string(pod.UID) == session.Status.FencingPodUID {
			return false, "OldPodStillPresent", "old Pod UID remains authoritatively present", nil
		}
		return false, "UnexpectedPodPresent", "another Pod exists before the old generation fence was proven", nil
	}
	if !apierrors.IsNotFound(err) {
		return false, "FenceEvidenceUnavailable", "authoritative Pod evidence is unavailable", nil
	}
	if session.Status.GenerationSecretName != "" {
		var secret corev1.Secret
		err = reader.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: session.Status.GenerationSecretName}, &secret)
		if err == nil {
			return false, "GenerationAuthStillPresent", "generation authentication still exists", nil
		}
		if !apierrors.IsNotFound(err) {
			return false, "FenceEvidenceUnavailable", "authoritative generation-auth evidence is unavailable", nil
		}
	}
	var service corev1.Service
	err = reader.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: SessionServiceName(session)}, &service)
	if err == nil && len(service.Spec.Selector) != 0 {
		return false, "RouteStillPublished", "old Service selector can still route", nil
	}
	if err != nil && !apierrors.IsNotFound(err) {
		return false, "FenceEvidenceUnavailable", "authoritative Service evidence is unavailable", nil
	}
	requiresAttachmentProof := session.Status.FencingPodUID != "" ||
		session.Status.PodUID != "" ||
		session.Status.GenerationSecretName != "" ||
		session.Status.FencingVolumeIdentity != "" ||
		(session.Status.FenceState != clusterv1alpha1.RuntimeFenceNoPriorWriter && session.Status.FencingGeneration != "")
	if requiresAttachmentProof && session.Status.FencingVolumeIdentity == "" {
		return false, "StorageIdentityUncertain", "old runtime-state volume identity is unavailable while attachment evidence is required", nil
	}
	if session.Status.FencingVolumeIdentity != "" {
		var attachments storagev1.VolumeAttachmentList
		if err := reader.List(ctx, &attachments); err != nil {
			return false, "FenceEvidenceUnavailable", "authoritative VolumeAttachment evidence is unavailable", nil
		}
		for index := range attachments.Items {
			volumeName := attachments.Items[index].Spec.Source.PersistentVolumeName
			if volumeName != nil && volumeIdentity(*volumeName) == session.Status.FencingVolumeIdentity {
				return false, "VolumeAttachmentUncertain", "old runtime-state volume still has a VolumeAttachment", nil
			}
		}
	}
	var lease coordinationv1.Lease
	err = reader.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: SessionWriterLeaseName(session)}, &lease)
	if err == nil && lease.Spec.HolderIdentity != nil && *lease.Spec.HolderIdentity != "" {
		return false, "WriterLeaseUncertain", "runtime-state writer Lease still has an owner", nil
	}
	if err != nil && !apierrors.IsNotFound(err) {
		return false, "FenceEvidenceUnavailable", "authoritative writer Lease evidence is unavailable", nil
	}
	return true, "FenceProven", "old workload, route, generation authentication, Lease owner, and VolumeAttachment are absent", nil
}

func (r *SessionReconciler) publishFenceUncertain(ctx context.Context, session *clusterv1alpha1.T4Session, reason, message string) error {
	before := session.Status
	if session.Status.Conditions != nil {
		before.Conditions = append([]metav1.Condition(nil), session.Status.Conditions...)
	}
	session.Status.ObservedGeneration = session.Generation
	session.Status.FenceState = clusterv1alpha1.RuntimeFenceUncertain
	session.Status.Phase = clusterv1alpha1.InfrastructureDegraded
	session.Status.PodName = ""
	session.Status.ServiceName = ""
	meta.SetStatusCondition(&session.Status.Conditions, condition("HostReady", metav1.ConditionUnknown, "FenceUncertain", "host dependency cannot authorize progress while fencing is uncertain", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("WorkspaceReady", metav1.ConditionUnknown, "FenceUncertain", "workspace dependency cannot authorize progress while fencing is uncertain", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("RuntimeConfigured", metav1.ConditionUnknown, "FenceUncertain", "runtime configuration cannot authorize progress while fencing is uncertain", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("StorageReady", metav1.ConditionUnknown, "FenceUncertain", "runtime-state attachment absence is uncertain", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("Fenced", metav1.ConditionFalse, "FenceUncertain", reason+": "+message, session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("RouteReady", metav1.ConditionFalse, "FenceUncertain", "route publication is blocked until explicit recovery under a new resource revision", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("Available", metav1.ConditionFalse, "FenceUncertain", "replacement is blocked because writer fencing is uncertain", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("TicketsRevoked", metav1.ConditionTrue, "NoTicketIssuer", "no Kubernetes ticket issuer exists before P2-06", session.Generation))
	authStatus := metav1.ConditionUnknown
	authReason := "GenerationAuthUncertain"
	authMessage := "generation authentication absence could not be proven"
	if session.Status.GenerationSecretName == "" {
		authStatus = metav1.ConditionTrue
		authReason = "NoGenerationAuth"
		authMessage = "no generation authentication resource was committed"
	} else if revoked := meta.FindStatusCondition(session.Status.Conditions, "GenerationAuthRevoked"); revoked != nil && revoked.Status == metav1.ConditionTrue {
		authStatus = metav1.ConditionTrue
		authReason = revoked.Reason
		authMessage = revoked.Message
	}
	meta.SetStatusCondition(&session.Status.Conditions, condition("GenerationAuthRevoked", authStatus, authReason, authMessage, session.Generation))
	if reflect.DeepEqual(before, session.Status) {
		return nil
	}
	return r.Status().Update(ctx, session)
}

func podConditionTrue(pod *corev1.Pod, conditionType corev1.PodConditionType) bool {
	for _, item := range pod.Status.Conditions {
		if item.Type == conditionType {
			return item.Status == corev1.ConditionTrue
		}
	}
	return false
}

func (r *SessionReconciler) compositeRuntimeReady(ctx context.Context, session *clusterv1alpha1.T4Session, pod *corev1.Pod, pvc *corev1.PersistentVolumeClaim) (bool, string, string, error) {
	var authoritativeSession clusterv1alpha1.T4Session
	if err := r.authoritativeReader().Get(ctx, client.ObjectKeyFromObject(session), &authoritativeSession); err != nil {
		return false, "", "", err
	}
	if authoritativeSession.UID != session.UID || authoritativeSession.ResourceVersion != session.ResourceVersion ||
		authoritativeSession.Generation != session.Generation || authoritativeSession.Status.RuntimeGeneration != session.Status.RuntimeGeneration {
		return false, "SessionAuthorityChanged", "session resource revision or runtime generation changed during readiness proof", nil
	}
	var authoritativePod corev1.Pod
	if err := r.authoritativeReader().Get(ctx, client.ObjectKeyFromObject(pod), &authoritativePod); err != nil {
		if apierrors.IsNotFound(err) {
			return false, "PodNotReady", "current Pod does not exist in authoritative API state", nil
		}
		return false, "", "", err
	}
	if authoritativePod.UID != pod.UID || !sessionExclusivelyOwnsResource(&authoritativePod, session) ||
		authoritativePod.Annotations[clusterv1alpha1.SessionPodSpecHashAnnotation] != pod.Annotations[clusterv1alpha1.SessionPodSpecHashAnnotation] {
		return false, "PodAuthorityChanged", "authoritative Pod identity or specification differs from the reconciled Pod", nil
	}
	pod = &authoritativePod
	var authoritativePVC corev1.PersistentVolumeClaim
	if err := r.authoritativeReader().Get(ctx, client.ObjectKeyFromObject(pvc), &authoritativePVC); err != nil {
		if apierrors.IsNotFound(err) {
			return false, "StorageNotReady", "runtime-state PVC does not exist in authoritative API state", nil
		}
		return false, "", "", err
	}
	if authoritativePVC.UID != pvc.UID || !sessionExclusivelyOwnsResource(&authoritativePVC, session) ||
		!runtimeStatePVCSpecMatches(&authoritativePVC, pvc) {
		return false, "RuntimeStatePVCAuthorityChanged", "authoritative runtime-state PVC identity or specification changed", nil
	}
	pvc = &authoritativePVC
	if session.Spec.DesiredState != "" && session.Spec.DesiredState != clusterv1alpha1.DesiredStateRunning {
		return false, "DesiredStateNotRunning", "route publication requires desiredState=Running", nil
	}
	if pod.UID == "" {
		return false, "WriterIdentityNotReady", "Pod UID is required for exclusive writer authority", nil
	}
	if !podReady(pod) || pod.Status.Phase != corev1.PodRunning {
		return false, "PodNotReady", "Pod readiness and Running phase are required", nil
	}
	if !podConditionTrue(pod, corev1.PodScheduled) {
		return false, "SchedulingNotReady", "Pod scheduling has not been proven", nil
	}
	if pvc.Status.Phase != corev1.ClaimBound {
		return false, "StorageNotReady", "runtime-state PVC is not Bound", nil
	}
	var lease coordinationv1.Lease
	if err := r.authoritativeReader().Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: SessionWriterLeaseName(session)}, &lease); err != nil {
		if apierrors.IsNotFound(err) {
			return false, "WriterLeaseNotReady", "exclusive writer Lease does not exist", nil
		}
		return false, "", "", err
	}
	if !sessionExclusivelyOwnsResource(&lease, session) {
		return false, "WriterLeaseNotReady", "exclusive writer Lease ownership is not authoritative", nil
	}
	if lease.Annotations[writerLeaseGenerationAnnotation] != session.Status.RuntimeGeneration {
		return false, "WriterLeaseNotReady", "exclusive writer Lease belongs to a stale runtime generation", nil
	}
	if lease.Spec.HolderIdentity == nil || *lease.Spec.HolderIdentity != string(pod.UID) {
		return false, "WriterLeaseNotReady", "exclusive writer Lease is not held by the current Pod UID", nil
	}
	return true, "CompositeReady", "all route-readiness authorities are proven", nil
}

func SessionCmuxName(session *clusterv1alpha1.T4Session) string {
	if session.Spec.CmuxSessionName != "" {
		return session.Spec.CmuxSessionName
	}
	return strings.TrimPrefix(SessionPodName(session), "t4-session-")
}

func RuntimeStateFilesystemRoot(session *clusterv1alpha1.T4Session) string {
	return stableName("runtime-", session.Name, session.UID)
}

func RuntimeStatePVCName(session *clusterv1alpha1.T4Session) string {
	return stableName("t4-runtime-", session.Name, session.UID)
}

func runtimeStateAccessMode(profile *clusterv1alpha1.RuntimeStateStorageProfile) corev1.PersistentVolumeAccessMode {
	mode, _ := RuntimeStatePVCMode(profile)
	return mode
}

func desiredRuntimeStatePVC(session *clusterv1alpha1.T4Session, profile *clusterv1alpha1.RuntimeStateStorageProfile) corev1.PersistentVolumeClaim {
	claim := corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{
			Name:      RuntimeStatePVCName(session),
			Namespace: session.Namespace,
			Labels: map[string]string{
				"app.kubernetes.io/name":    "t4-session-runtime-state",
				"app.kubernetes.io/part-of": "t4-cluster",
			},
		},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes:      []corev1.PersistentVolumeAccessMode{runtimeStateAccessMode(profile)},
			StorageClassName: ptr(profile.StorageClassName),
			VolumeMode:       ptr(corev1.PersistentVolumeFilesystem),
			Resources: corev1.VolumeResourceRequirements{
				Requests: corev1.ResourceList{corev1.ResourceStorage: profile.Size.DeepCopy()},
			},
		},
	}
	if snapshot := session.Spec.RuntimeStateRestoreSnapshotRef; snapshot != nil {
		claim.Spec.DataSource = &corev1.TypedLocalObjectReference{
			APIGroup: ptr("snapshot.storage.k8s.io"),
			Kind:     "VolumeSnapshot",
			Name:     snapshot.Name,
		}
	}
	return claim
}

func runtimeStatePVCSpecMatches(actual *corev1.PersistentVolumeClaim, desired *corev1.PersistentVolumeClaim) bool {
	if pvcStorageClassName(actual) != pvcStorageClassName(desired) ||
		!reflect.DeepEqual(actual.Spec.AccessModes, desired.Spec.AccessModes) ||
		!actual.Spec.Resources.Requests[corev1.ResourceStorage].Equal(desired.Spec.Resources.Requests[corev1.ResourceStorage]) ||
		!reflect.DeepEqual(actual.Spec.VolumeMode, desired.Spec.VolumeMode) ||
		!reflect.DeepEqual(actual.Spec.Selector, desired.Spec.Selector) ||
		!reflect.DeepEqual(actual.Spec.DataSource, desired.Spec.DataSource) ||
		!reflect.DeepEqual(actual.Spec.DataSourceRef, desired.Spec.DataSourceRef) {
		return false
	}
	return true
}

func (r *SessionReconciler) reconcileRuntimeStatePVC(ctx context.Context, session *clusterv1alpha1.T4Session, host *clusterv1alpha1.T4ClusterHost) (*corev1.PersistentVolumeClaim, string, string, error) {
	profile := host.Spec.RuntimeStateStorageProfile
	if profile == nil {
		return nil, "RuntimeStateStorageProfileMissing", "referenced T4ClusterHost does not declare a runtime-state storage profile", nil
	}
	if profile.Size.Sign() <= 0 {
		return nil, "RuntimeStateStorageSizeInvalid", "runtime-state storage profile size must be greater than zero", nil
	}
	if _, err := RuntimeStatePVCMode(profile); err != nil {
		return nil, "RuntimeStateAccessModeInvalid", err.Error(), nil
	}
	var storageClass storagev1.StorageClass
	if err := r.Get(ctx, types.NamespacedName{Name: profile.StorageClassName}, &storageClass); err != nil {
		if apierrors.IsNotFound(err) {
			return nil, "RuntimeStateStorageClassNotFound", fmt.Sprintf("runtime-state StorageClass %q does not exist", profile.StorageClassName), nil
		}
		return nil, "", "", err
	}

	if snapshot := session.Spec.RuntimeStateRestoreSnapshotRef; snapshot != nil {
		if profile.VolumeSnapshotClassName == "" {
			return nil, "RuntimeStateSnapshotClassMissing", "runtime-state restore requires a selected VolumeSnapshotClass", nil
		}
		snapshotObject, validateErr := ValidateRestoreSnapshot(ctx, r.Client, session.Namespace, snapshot, SnapshotSourceRuntimeState, profile.StorageClassName, profile.VolumeSnapshotClassName, session.Spec.AllowCrashConsistentRestore)
		if validateErr != nil {
			return nil, "RuntimeStateSnapshotInvalid", validateErr.Error(), nil
		}
		if err := validateRestoreGeneration(session, snapshotObject); err != nil {
			return nil, "RestoreGenerationNotAdvanced", err.Error(), nil
		}
		if err := ValidateRestorePublicID(session, snapshotObject); err != nil {
			return nil, "RestorePublicIDInvalid", err.Error(), nil
		}
		var sessions clusterv1alpha1.T4SessionList
		if err := r.List(ctx, &sessions, client.InNamespace(session.Namespace)); err != nil {
			return nil, "", "", err
		}
		if err := RejectSnapshotInUse(sessions.Items, session.Namespace, snapshot.Name, session.UID); err != nil {
			return nil, "RuntimeStateSnapshotInUse", err.Error(), nil
		}
	}

	desired := desiredRuntimeStatePVC(session, profile)
	if err := controllerutil.SetControllerReference(session, &desired, r.Scheme); err != nil {
		return nil, "", "", err
	}
	key := client.ObjectKeyFromObject(&desired)
	var pvc corev1.PersistentVolumeClaim
	if err := r.Get(ctx, key, &pvc); apierrors.IsNotFound(err) {
		pvc = desired
		if err := r.Create(ctx, &pvc); err != nil {
			if !apierrors.IsAlreadyExists(err) {
				return nil, "", "", err
			}
			reader := r.APIReader
			if reader == nil {
				reader = r.Client
			}
			if err := reader.Get(ctx, key, &pvc); err != nil {
				return nil, "", "", err
			}
		}
	} else if err != nil {
		return nil, "", "", err
	}
	if !sessionExclusivelyOwnsResource(&pvc, session) {
		return nil, "RuntimeStatePVCOwnershipConflict", "deterministic runtime-state PVC has an unexpected owner", nil
	}
	if !runtimeStatePVCSpecMatches(&pvc, &desired) {
		return nil, "RuntimeStatePVCSpecConflict", "deterministic runtime-state PVC immutable storage specification differs from the host profile or restore snapshot", nil
	}
	reason, message, err := r.authoritativeRuntimeStatePVCValidation(ctx, session, &pvc, profile)
	if err != nil || reason != "" {
		return nil, reason, message, err
	}
	return &pvc, "", "", nil
}

func (r *SessionReconciler) authoritativeRuntimeStatePVCValidation(ctx context.Context, session *clusterv1alpha1.T4Session, cachedPVC *corev1.PersistentVolumeClaim, profile *clusterv1alpha1.RuntimeStateStorageProfile) (string, string, error) {
	if profile == nil {
		return "RuntimeStateStorageProfileMissing", "referenced T4ClusterHost does not declare a runtime-state storage profile", nil
	}
	reader := r.APIReader
	if reader == nil {
		reader = r.Client
	}
	var authoritative corev1.PersistentVolumeClaim
	if err := reader.Get(ctx, client.ObjectKeyFromObject(cachedPVC), &authoritative); err != nil {
		if apierrors.IsNotFound(err) {
			return "RuntimeStatePVCAuthorityChanged", "runtime-state PVC does not exist in authoritative API state", nil
		}
		return "", "", err
	}
	if authoritative.UID != cachedPVC.UID {
		return "RuntimeStatePVCAuthorityChanged", "authoritative runtime-state PVC UID differs from the validated cached PVC", nil
	}
	desired := desiredRuntimeStatePVC(session, profile)
	if !sessionExclusivelyOwnsResource(&authoritative, session) {
		return "RuntimeStatePVCAuthorityChanged", "authoritative runtime-state PVC is not exclusively controlled by the session", nil
	}
	if !runtimeStatePVCSpecMatches(&authoritative, &desired) {
		return "RuntimeStatePVCAuthorityChanged", "authoritative runtime-state PVC immutable storage specification changed", nil
	}
	return "", "", nil
}

func (r *SessionReconciler) updateRuntimeStateStatus(ctx context.Context, session *clusterv1alpha1.T4Session, pvc *corev1.PersistentVolumeClaim) error {
	original := session.Status
	if session.Status.Conditions != nil {
		original.Conditions = append([]metav1.Condition(nil), session.Status.Conditions...)
	}
	session.Status.RuntimeStatePVCName = pvc.Name
	session.Status.RuntimeStateStorageClassName = pvcStorageClassName(pvc)
	if identity := volumeIdentity(pvc.Spec.VolumeName); identity != "" {
		session.Status.RuntimeStateVolumeIdentity = identity
	}
	capacity := pvc.Status.Capacity[corev1.ResourceStorage]
	if capacity.Sign() <= 0 {
		capacity = pvc.Spec.Resources.Requests[corev1.ResourceStorage]
	}
	session.Status.RuntimeStateCapacity = ptrQuantity(capacity.DeepCopy())
	if snapshot := session.Spec.RuntimeStateRestoreSnapshotRef; snapshot != nil {
		session.Status.RuntimeStateSnapshotRef = snapshot.DeepCopy()
	} else {
		session.Status.RuntimeStateSnapshotRef = nil
	}
	if reflect.DeepEqual(original, session.Status) {
		return nil
	}
	return r.Status().Update(ctx, session)
}

func (r *SessionReconciler) clearRuntimeStateStatus(ctx context.Context, session *clusterv1alpha1.T4Session) error {
	original := session.Status
	if session.Status.Conditions != nil {
		original.Conditions = append([]metav1.Condition(nil), session.Status.Conditions...)
	}
	session.Status.RuntimeStatePVCName = ""
	session.Status.RuntimeStateVolumeIdentity = ""
	session.Status.RuntimeStateStorageClassName = ""
	session.Status.RuntimeStateCapacity = nil
	session.Status.RuntimeStateSnapshotRef = nil
	if reflect.DeepEqual(original, session.Status) {
		return nil
	}
	return r.Status().Update(ctx, session)
}

func (r *SessionReconciler) reconcileInactive(ctx context.Context, session *clusterv1alpha1.T4Session, desiredState clusterv1alpha1.DesiredState) (ctrl.Result, error) {
	reader := r.authoritativeReader()
	if session.Status.FenceState == clusterv1alpha1.RuntimeFenceUncertain {
		return ctrl.Result{}, nil
	}
	var pod corev1.Pod
	podKey := types.NamespacedName{Namespace: session.Namespace, Name: SessionPodName(session)}
	podErr := reader.Get(ctx, podKey, &pod)
	if podErr != nil && !apierrors.IsNotFound(podErr) {
		return ctrl.Result{}, podErr
	}
	var service corev1.Service
	serviceKey := types.NamespacedName{Namespace: session.Namespace, Name: SessionServiceName(session)}
	serviceErr := reader.Get(ctx, serviceKey, &service)
	if serviceErr != nil && !apierrors.IsNotFound(serviceErr) {
		return ctrl.Result{}, serviceErr
	}
	if podErr == nil && !sessionExclusivelyOwnsResource(&pod, session) {
		if err := r.deleteOwnedSessionResourcesWithFailure(ctx, reader, session, false, false, false, "PodOwnershipConflict", "deterministic session Pod has an unexpected owner"); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{}, nil
	}
	if serviceErr == nil && !sessionExclusivelyOwnsResource(&service, session) {
		if err := r.deleteOwnedSessionResourcesWithFailure(ctx, reader, session, false, false, false, "ServiceOwnershipConflict", "deterministic session Service has an unexpected owner"); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{}, nil
	}
	if podErr == nil {
		if err := r.beginGenerationDrain(ctx, session, &pod, &service, "DesiredStateInactive", "session is draining before entering its inactive state"); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: time.Second}, nil
	}
	authorityRemains := serviceErr == nil && len(service.Spec.Selector) != 0
	if session.Status.FenceState != clusterv1alpha1.RuntimeFenceShutdownRequested &&
		session.Status.FenceState != clusterv1alpha1.RuntimeFenceVerifying {
		authorityRemains = authorityRemains || session.Status.PodUID != ""
		if session.Status.GenerationSecretName != "" {
			var secret corev1.Secret
			secretErr := reader.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: session.Status.GenerationSecretName}, &secret)
			if secretErr == nil {
				authorityRemains = true
			} else if !apierrors.IsNotFound(secretErr) {
				return ctrl.Result{}, secretErr
			}
		}
		var lease coordinationv1.Lease
		leaseErr := reader.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: SessionWriterLeaseName(session)}, &lease)
		if leaseErr == nil {
			authorityRemains = true
		} else if !apierrors.IsNotFound(leaseErr) {
			return ctrl.Result{}, leaseErr
		}
	}
	if authorityRemains {
		if err := r.beginGenerationDrain(ctx, session, &corev1.Pod{}, &service, "DesiredStateInactive", "session authority is draining before entering its inactive state"); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: time.Second}, nil
	}
	var pvc corev1.PersistentVolumeClaim
	if session.Status.RuntimeStatePVCName != "" {
		if err := reader.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: session.Status.RuntimeStatePVCName}, &pvc); err != nil && !apierrors.IsNotFound(err) {
			return ctrl.Result{}, err
		}
	}
	if session.Status.FenceState == clusterv1alpha1.RuntimeFenceShutdownRequested {
		if err := r.enterFenceVerifying(ctx, session); err != nil {
			return ctrl.Result{}, err
		}
	}
	proven, reason, message, err := r.positiveFenceProof(ctx, session, &pvc)
	if err != nil {
		return ctrl.Result{}, err
	}
	if !proven {
		if err := r.publishFenceUncertain(ctx, session, reason, message); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{}, nil
	}
	original := session.Status
	if session.Status.Conditions != nil {
		original.Conditions = append([]metav1.Condition(nil), session.Status.Conditions...)
	}
	session.Status.ObservedGeneration = session.Generation
	session.Status.PodName = ""
	session.Status.PodUID = ""
	session.Status.ServiceName = ""
	session.Status.FenceState = clusterv1alpha1.RuntimeFenceProven
	meta.SetStatusCondition(&session.Status.Conditions, condition("HostReady", metav1.ConditionUnknown, "Inactive", "host dependency is not evaluated while the session is inactive", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("WorkspaceReady", metav1.ConditionUnknown, "Inactive", "workspace dependency is not evaluated while the session is inactive", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("RuntimeConfigured", metav1.ConditionUnknown, "Inactive", "runtime configuration is not evaluated while the session is inactive", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("Fenced", metav1.ConditionTrue, "FenceProven", "no runtime writer, route, generation authentication, Lease owner, or VolumeAttachment remains", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("StorageReady", metav1.ConditionFalse, "Inactive", "runtime-state storage is retained but not attached to an active workload", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("RouteReady", metav1.ConditionFalse, "Inactive", "inactive sessions never publish routes or mint tickets", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("TicketsRevoked", metav1.ConditionTrue, "NoTicketIssuer", "no Kubernetes ticket issuer exists before P2-06", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("GenerationAuthRevoked", metav1.ConditionTrue, "GenerationAuthAbsent", "generation-bound authentication is absent while the session is inactive", session.Generation))
	stateReason := "SessionSleeping"
	stateMessage := "session runtime is fenced while sleeping; durable runtime state is retained"
	session.Status.Phase = clusterv1alpha1.InfrastructureSleeping
	if desiredState == clusterv1alpha1.DesiredStateStopped {
		stateReason = "SessionStopped"
		stateMessage = "session runtime is fenced while stopped; durable runtime state is retained"
		session.Status.Phase = clusterv1alpha1.InfrastructureStopped
	}
	meta.SetStatusCondition(&session.Status.Conditions, condition("Available", metav1.ConditionFalse, stateReason, stateMessage, session.Generation))
	if !reflect.DeepEqual(original, session.Status) {
		if err := r.Status().Update(ctx, session); err != nil {
			return ctrl.Result{}, err
		}
	}
	return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
}

func newRuntimeGeneration() (string, error) {
	var entropy [18]byte
	if _, err := rand.Read(entropy[:]); err != nil {
		return "", fmt.Errorf("generate runtime generation: %w", err)
	}
	return "gen_" + base64.RawURLEncoding.EncodeToString(entropy[:]), nil
}

func (r *SessionReconciler) ensureSessionLifecycleStatus(ctx context.Context, session *clusterv1alpha1.T4Session) error {
	original := session.Status
	if session.Status.Conditions != nil {
		original.Conditions = append([]metav1.Condition(nil), session.Status.Conditions...)
	}
	if session.Status.RuntimeGeneration == "" {
		generation, err := newRuntimeGeneration()
		if err != nil {
			return err
		}
		session.Status.RuntimeGeneration = generation
	}
	if session.Status.FenceState == "" {
		session.Status.FenceState = clusterv1alpha1.RuntimeFenceNoPriorWriter
	}
	if session.Status.CmuxSessionName == "" {
		session.Status.CmuxSessionName = SessionCmuxName(session)
	}
	session.Status.RuntimeStateFilesystemRoot = RuntimeStateFilesystemRoot(session)
	if reflect.DeepEqual(original, session.Status) {
		return nil
	}
	return r.Status().Update(ctx, session)
}

func (r *SessionReconciler) authoritativePVCValidation(ctx context.Context, workspace *clusterv1alpha1.T4Workspace, cachedPVC *corev1.PersistentVolumeClaim, storageClassName string) (string, string, error) {
	reader := r.APIReader
	if reader == nil {
		reader = r.Client
	}
	var authoritativePVC corev1.PersistentVolumeClaim
	if err := reader.Get(ctx, client.ObjectKeyFromObject(cachedPVC), &authoritativePVC); err != nil {
		if apierrors.IsNotFound(err) {
			return "PVCAuthorityChanged", "workspace PVC does not exist in authoritative API state", nil
		}
		return "", "", err
	}
	if authoritativePVC.UID != cachedPVC.UID {
		return "PVCAuthorityChanged", "authoritative workspace PVC UID differs from the validated cached PVC", nil
	}
	if workspace.UID != "" && !workspaceOwnsPVC(workspace, &authoritativePVC) {
		return "PVCAuthorityChanged", "authoritative workspace PVC owner reference does not belong to the workspace", nil
	}
	if pvcStorageClassName(&authoritativePVC) != storageClassName {
		return "PVCAuthorityChanged", fmt.Sprintf("authoritative workspace PVC uses StorageClass %q instead of host-selected %q", pvcStorageClassName(&authoritativePVC), storageClassName), nil
	}
	if !pvcHasRWX(&authoritativePVC) {
		return "PVCAuthorityChanged", "authoritative workspace PVC does not request ReadWriteMany", nil
	}
	if authoritativePVC.Status.Phase != corev1.ClaimBound {
		return "PVCAuthorityChanged", "authoritative workspace PVC is not Bound", nil
	}
	return "", "", nil
}

func (r *SessionReconciler) desiredPod(session *clusterv1alpha1.T4Session, workspacePVCName, runtimeStatePVCName, podName string, labels map[string]string, runtimeVersions ompResourceVersions) (corev1.Pod, error) {
	falseValue := false
	trueValue := true
	authorityUID := int64(10001)
	shellUID := int64(10002)
	credentialUID := int64(10003)
	sessionGID := int64(20001)
	fsGroupChangePolicy := corev1.FSGroupChangeOnRootMismatch
	grace := int64(45)
	browserEnabled := session.Spec.BrowserPolicy == clusterv1alpha1.BrowserPolicyAllowed ||
		(session.Spec.BrowserPolicy == "" && session.Spec.GUIEnabled)
	shmSize := r.SharedMemorySize.DeepCopy()
	if shmSize.IsZero() {
		shmSize = apiresource.MustParse("1Gi")
	}
	temporarySize := r.TemporarySize.DeepCopy()
	if temporarySize.IsZero() {
		temporarySize = apiresource.MustParse("2Gi")
	}
	resources := r.Resources.DeepCopy()
	if resources.Requests == nil {
		resources.Requests = corev1.ResourceList{corev1.ResourceCPU: apiresource.MustParse("500m"), corev1.ResourceMemory: apiresource.MustParse("1Gi")}
	}
	if resources.Limits == nil {
		resources.Limits = corev1.ResourceList{corev1.ResourceCPU: apiresource.MustParse("4"), corev1.ResourceMemory: apiresource.MustParse("8Gi")}
	}
	sessionServiceAccount := SessionServiceAccountName(session)
	serverServiceAccount := r.ServerServiceAccountName
	if serverServiceAccount == "" {
		serverServiceAccount = DefaultServerServiceAccount
	}
	kubernetesAPIAudience := r.KubernetesAPIAudience
	if kubernetesAPIAudience == "" {
		kubernetesAPIAudience = DefaultKubernetesAPIAudience
	}
	excluded := r.ExcludedNodeNames
	if len(excluded) == 0 {
		excluded = []string{"k3s-worker-02"}
	}
	runtimeID := session.Status.RuntimeStateFilesystemRoot
	stateRoot := "/runtime-state/" + runtimeID
	shortRuntimeRoot := "/run/t4/" + runtimeID
	authority := corev1.Container{
		Name: "session-authority", Image: r.RuntimeImage, ImagePullPolicy: corev1.PullIfNotPresent,
		Ports: []corev1.ContainerPort{{Name: "host", ContainerPort: 8787, Protocol: corev1.ProtocolTCP}},
		Env: []corev1.EnvVar{
			{Name: "T4_CREDENTIAL_BROKER_SOCKET", Value: "/run/t4-credential/broker.sock"},
			{Name: "T4_SESSION_NAME", Value: session.Status.CmuxSessionName},
			{Name: "T4_RUNTIME_ID", Value: runtimeID},
			{Name: "T4_SESSION_STATE_ID", Value: runtimeID},
			{Name: "T4_RUNTIME_UID", Value: string(session.UID)},
			{Name: "T4_RUNTIME_GENERATION", Value: session.Status.RuntimeGeneration},
			{Name: "T4_WORKSPACE_ROOT", Value: "/workspace"},
			{Name: "T4_SESSION_STATE_ROOT", Value: stateRoot},
			{Name: "T4_AUTHORITY_STATE_DIR", Value: stateRoot + "/authority"},
			{Name: "T4_CMUX_STATE_DIR", Value: stateRoot + "/cmux"},
			{Name: "T4_BROWSER_STATE_DIR", Value: stateRoot + "/browser"},
			{Name: "T4_ARTIFACT_ROOT", Value: stateRoot + "/artifacts"},
			{Name: "T4_PRIVATE_RUNTIME_DIR", Value: stateRoot + "/private"},
			{Name: "T4_OMP_HOME", Value: stateRoot + "/home"},
			{Name: "T4_HOST_RUNTIME_DIR", Value: shortRuntimeRoot},
			{Name: "T4_CMUX_SOCKET_PATH", Value: shortRuntimeRoot + "/c.sock"},
			{Name: "T4_SESSION_HOST_READY_PATH", Value: shortRuntimeRoot + "/host.ready"},
			{Name: "T4_CMUX_SOCKET_MODE", Value: "0660"},
			{Name: "T4_GUI_ENABLED", Value: fmt.Sprintf("%t", browserEnabled)},
			{Name: "T4_IDLE_POLICY", Value: "allow-idle-sleep"},
			{Name: "T4_RUNTIME_KEEPALIVE", Value: "false"},
			{Name: "DISPLAY", Value: ":99"},
			{Name: "T4_OMP_CONFIG_SOURCE_DIR", Value: "/run/t4-omp-config-source"},
			{Name: "T4_AUTHORITY_HEALTH_SOCKET", Value: shortRuntimeRoot + "/authority-health.sock"},
		},
		VolumeMounts: []corev1.VolumeMount{
			{Name: "workspace", MountPath: "/workspace"},
			{Name: "runtime-state", MountPath: "/runtime-state"},
			{Name: "runtime", MountPath: "/run"},
			{Name: "credential-broker", MountPath: "/run/t4-credential"},
			{Name: "authority-temporary", MountPath: "/tmp"},
			{Name: "omp-config-source", MountPath: "/run/t4-omp-config-source", ReadOnly: true},
		},
		SecurityContext: &corev1.SecurityContext{
			AllowPrivilegeEscalation: &falseValue, ReadOnlyRootFilesystem: &trueValue, RunAsNonRoot: &trueValue,
			RunAsUser: &authorityUID, RunAsGroup: &sessionGID, Capabilities: &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
		},
		Resources: *resources,
		StartupProbe: &corev1.Probe{
			ProbeHandler:     corev1.ProbeHandler{Exec: &corev1.ExecAction{Command: []string{"/usr/local/bin/bun", "/opt/t4/packages/cluster-server/src/session-authority-health.ts"}}},
			FailureThreshold: 30, PeriodSeconds: 2, TimeoutSeconds: 2,
		},
		ReadinessProbe: &corev1.Probe{
			ProbeHandler:     corev1.ProbeHandler{Exec: &corev1.ExecAction{Command: []string{"/usr/local/bin/bun", "/opt/t4/packages/cluster-server/src/session-authority-health.ts"}}},
			FailureThreshold: 2, PeriodSeconds: 5, TimeoutSeconds: 2,
		},
		LivenessProbe: &corev1.Probe{
			ProbeHandler:     corev1.ProbeHandler{Exec: &corev1.ExecAction{Command: []string{"/usr/local/bin/bun", "/opt/t4/packages/cluster-server/src/session-authority-health.ts"}}},
			FailureThreshold: 3, PeriodSeconds: 10, TimeoutSeconds: 2,
		},
		Lifecycle: &corev1.Lifecycle{PreStop: &corev1.LifecycleHandler{Exec: &corev1.ExecAction{Command: []string{"/bin/bash", "-c", `/usr/local/bin/bun -e 'const ready=JSON.parse(await Bun.file(process.env.T4_SESSION_HOST_READY_PATH).text()); process.kill(ready.pid, "SIGTERM")'; while test -e "$T4_SESSION_HOST_READY_PATH"; do sleep 0.05; done`}}}},
	}
	shell := corev1.Container{
		Name: "session-shell", Image: r.RuntimeImage, ImagePullPolicy: corev1.PullIfNotPresent,
		Command: []string{"/usr/bin/tini", "--", "/usr/local/bin/t4-session-shell"},
		Env: []corev1.EnvVar{
			{Name: "T4_SESSION_NAME", Value: session.Status.CmuxSessionName},
			{Name: "T4_RUNTIME_ID", Value: runtimeID},
			{Name: "T4_SESSION_STATE_ID", Value: runtimeID},
			{Name: "T4_RUNTIME_GENERATION", Value: session.Status.RuntimeGeneration},
			{Name: "T4_WORKSPACE_ROOT", Value: "/workspace"},
			{Name: "T4_SESSION_STATE_ROOT", Value: stateRoot},
			{Name: "T4_CMUX_STATE_DIR", Value: stateRoot + "/cmux"},
			{Name: "T4_BROWSER_STATE_DIR", Value: stateRoot + "/browser"},
			{Name: "T4_HOST_RUNTIME_DIR", Value: shortRuntimeRoot},
			{Name: "T4_CMUX_SOCKET_PATH", Value: shortRuntimeRoot + "/c.sock"},
			{Name: "T4_SESSION_HOST_READY_PATH", Value: shortRuntimeRoot + "/host.ready"},
			{Name: "T4_CMUX_SOCKET_MODE", Value: "0660"},
			{Name: "T4_GUI_ENABLED", Value: fmt.Sprintf("%t", browserEnabled)},
			{Name: "DISPLAY", Value: ":99"},
		},
		VolumeMounts: []corev1.VolumeMount{
			{Name: "workspace", MountPath: "/workspace"},
			{Name: "runtime-state", MountPath: "/runtime-state"},
			{Name: "runtime", MountPath: "/run"},
			{Name: "temporary", MountPath: "/tmp"},
			{Name: "shared-memory", MountPath: "/dev/shm"},
		},
		SecurityContext: &corev1.SecurityContext{
			AllowPrivilegeEscalation: &falseValue, ReadOnlyRootFilesystem: &trueValue, RunAsNonRoot: &trueValue,
			RunAsUser: &shellUID, RunAsGroup: &sessionGID, Capabilities: &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
		},
		Resources: *resources,
		StartupProbe: &corev1.Probe{
			ProbeHandler:     corev1.ProbeHandler{Exec: &corev1.ExecAction{Command: []string{"/usr/local/bin/bun", "/usr/local/lib/t4/session-runtime-readiness.js", "startup", "shell"}}},
			FailureThreshold: 30, PeriodSeconds: 2, TimeoutSeconds: 2,
		},
		ReadinessProbe: &corev1.Probe{
			ProbeHandler:     corev1.ProbeHandler{Exec: &corev1.ExecAction{Command: []string{"/usr/local/bin/bun", "/usr/local/lib/t4/session-runtime-readiness.js", "readiness", "shell"}}},
			FailureThreshold: 2, PeriodSeconds: 5, TimeoutSeconds: 2,
		},
		LivenessProbe: &corev1.Probe{
			ProbeHandler:     corev1.ProbeHandler{Exec: &corev1.ExecAction{Command: []string{"/usr/local/bin/bun", "/usr/local/lib/t4/session-runtime-readiness.js", "liveness", "shell"}}},
			FailureThreshold: 3, PeriodSeconds: 10, TimeoutSeconds: 2,
		},
		Lifecycle: &corev1.Lifecycle{PreStop: &corev1.LifecycleHandler{Exec: &corev1.ExecAction{Command: []string{"/bin/bash", "-c", "while test -e \"$T4_SESSION_HOST_READY_PATH\"; do sleep 0.05; done"}}}},
	}
	credential := corev1.Container{
		Name: "session-credential", Image: r.RuntimeImage, ImagePullPolicy: corev1.PullIfNotPresent,
		Command: []string{"/usr/bin/tini", "--", "/usr/local/bin/bun", "/usr/local/lib/t4/session-credential-broker.js"},
		Ports:   []corev1.ContainerPort{{Name: "activity", ContainerPort: 8788, Protocol: corev1.ProtocolTCP}},
		Env: []corev1.EnvVar{
			{Name: "T4_CLUSTER_SERVER_SERVICE_ACCOUNT", Value: serverServiceAccount},
			{Name: "T4_KUBERNETES_TOKEN_PATH", Value: "/var/run/secrets/kubernetes.io/serviceaccount/token"},
			{Name: "T4_KUBERNETES_CA_PATH", Value: "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"},
			{Name: "T4_KUBERNETES_NAMESPACE_PATH", Value: "/var/run/secrets/kubernetes.io/serviceaccount/namespace"},
			{Name: "T4_RUNTIME_GENERATION", Value: session.Status.RuntimeGeneration},
			{Name: "T4_RUNTIME_UID", Value: string(session.UID)},
			{Name: "T4_RUNTIME_ACTIVITY_PORT", Value: "8788"},
			{Name: "T4_CMUX_SOCKET_PATH", Value: "/run/t4-runtime-shared/t4/" + runtimeID + "/c.sock"},
			{Name: "T4_RUNTIME_ACTIVITY_SOCKET", Value: "/run/t4-credential/activity.sock"},
			{Name: "T4_WRITER_LEASE_NAME", Value: SessionWriterLeaseName(session)},
			{Name: "T4_GENERATION_AUTH_PATH", Value: generationAuthMountPath + "/" + generationAuthKey},
			{Name: "T4_CREDENTIAL_BROKER_SOCKET", Value: "/run/t4-credential/broker.sock"},
			{Name: "POD_UID", ValueFrom: &corev1.EnvVarSource{FieldRef: &corev1.ObjectFieldSelector{APIVersion: "v1", FieldPath: "metadata.uid"}}},
		},
		VolumeMounts: []corev1.VolumeMount{
			{Name: "credential-broker", MountPath: "/run/t4-credential"},
			{Name: "kubernetes-api-access", MountPath: "/var/run/secrets/kubernetes.io/serviceaccount", ReadOnly: true},
			{Name: "generation-auth", MountPath: generationAuthMountPath, ReadOnly: true},
			{Name: "runtime", MountPath: "/run/t4-runtime-shared"},
			{Name: "credential-temporary", MountPath: "/tmp"},
		},
		SecurityContext: &corev1.SecurityContext{
			AllowPrivilegeEscalation: &falseValue, ReadOnlyRootFilesystem: &trueValue, RunAsNonRoot: &trueValue,
			RunAsUser: &credentialUID, RunAsGroup: &sessionGID, Capabilities: &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
		},
		Resources: *resources,
	}
	volumes := []corev1.Volume{
		{Name: "workspace", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: workspacePVCName}}},
		{Name: "runtime-state", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: runtimeStatePVCName}}},
		{Name: "runtime", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{Medium: corev1.StorageMediumMemory, SizeLimit: ptrQuantity(apiresource.MustParse("128Mi"))}}},
		{Name: "authority-temporary", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{SizeLimit: &temporarySize}}},
		{Name: "temporary", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{SizeLimit: &temporarySize}}},
		{Name: "shared-memory", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{Medium: corev1.StorageMediumMemory, SizeLimit: &shmSize}}},
		{Name: "credential-broker", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{Medium: corev1.StorageMediumMemory, SizeLimit: ptrQuantity(apiresource.MustParse("8Mi"))}}},
		{Name: "credential-temporary", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{SizeLimit: ptrQuantity(apiresource.MustParse("16Mi"))}}},
		{Name: "kubernetes-api-access", VolumeSource: corev1.VolumeSource{Projected: &corev1.ProjectedVolumeSource{
			DefaultMode: ptr(int32(0440)),
			Sources: []corev1.VolumeProjection{
				{ServiceAccountToken: &corev1.ServiceAccountTokenProjection{Audience: kubernetesAPIAudience, ExpirationSeconds: ptr(SessionReviewerTokenExpirationSeconds), Path: "token"}},
				{ConfigMap: &corev1.ConfigMapProjection{LocalObjectReference: corev1.LocalObjectReference{Name: "kube-root-ca.crt"}, Items: []corev1.KeyToPath{{Key: "ca.crt", Path: "ca.crt"}}}},
				{DownwardAPI: &corev1.DownwardAPIProjection{Items: []corev1.DownwardAPIVolumeFile{{Path: "namespace", FieldRef: &corev1.ObjectFieldSelector{APIVersion: "v1", FieldPath: "metadata.namespace"}}}}},
			},
		}}},
		{Name: "generation-auth", VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{
			SecretName: session.Status.GenerationSecretName,
			Items:      []corev1.KeyToPath{{Key: generationAuthKey, Path: generationAuthKey, Mode: ptr(int32(0600))}},
		}}},
		{Name: "omp-config-source", VolumeSource: corev1.VolumeSource{ConfigMap: &corev1.ConfigMapVolumeSource{
			LocalObjectReference: corev1.LocalObjectReference{Name: r.OMPConfig.ConfigMapName},
			DefaultMode:          ptr(int32(0440)),
			Optional:             &falseValue,
			Items: []corev1.KeyToPath{
				{Key: r.OMPConfig.ModelsKey, Path: "models.yml", Mode: ptr(int32(0440))},
				{Key: r.OMPConfig.SettingsKey, Path: "config.yml", Mode: ptr(int32(0440))},
			},
		}}},
	}
	if session.Spec.InitialPromptSecretRef != nil {
		volumes = append(volumes, corev1.Volume{Name: "initial-prompt", VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{SecretName: session.Spec.InitialPromptSecretRef.Name, Items: []corev1.KeyToPath{{Key: "prompt", Path: "prompt", Mode: ptr(int32(0440))}}}}})
		authority.VolumeMounts = append(authority.VolumeMounts, corev1.VolumeMount{Name: "initial-prompt", MountPath: "/run/t4-initial-prompt", ReadOnly: true})
		authority.Env = append(authority.Env, corev1.EnvVar{Name: "T4_INITIAL_PROMPT_FILE", Value: "/run/t4-initial-prompt/prompt"})
	}
	pod := corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Name: podName, Namespace: session.Namespace, Labels: labels},
		Spec: corev1.PodSpec{
			AutomountServiceAccountToken:  &falseValue,
			ServiceAccountName:            sessionServiceAccount,
			EnableServiceLinks:            &falseValue,
			TerminationGracePeriodSeconds: &grace,
			SecurityContext:               &corev1.PodSecurityContext{RunAsNonRoot: &trueValue, FSGroup: &sessionGID, FSGroupChangePolicy: &fsGroupChangePolicy, SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault}},
			ShareProcessNamespace:         &trueValue,
			Affinity:                      &corev1.Affinity{NodeAffinity: &corev1.NodeAffinity{RequiredDuringSchedulingIgnoredDuringExecution: &corev1.NodeSelector{NodeSelectorTerms: []corev1.NodeSelectorTerm{{MatchExpressions: []corev1.NodeSelectorRequirement{{Key: "kubernetes.io/hostname", Operator: corev1.NodeSelectorOpNotIn, Values: excluded}}}}}}},
			Containers:                    []corev1.Container{authority, shell, credential}, Volumes: volumes,
		},
	}
	hashInput, err := json.Marshal(struct {
		PodSpec             corev1.PodSpec      `json:"podSpec"`
		OMPResourceVersions ompResourceVersions `json:"ompResourceVersions"`
	}{PodSpec: pod.Spec, OMPResourceVersions: runtimeVersions})
	if err != nil {
		return corev1.Pod{}, fmt.Errorf("serialize desired session Pod: %w", err)
	}
	hash := sha256.Sum256(hashInput)
	pod.Annotations = map[string]string{clusterv1alpha1.SessionPodSpecHashAnnotation: fmt.Sprintf("%x", hash)}
	return pod, nil
}
func (r *SessionReconciler) updateSessionPending(ctx context.Context, session *clusterv1alpha1.T4Session, podName, serviceName, reason, message string) error {
	original := session.Status
	if session.Status.Conditions != nil {
		original.Conditions = append([]metav1.Condition(nil), session.Status.Conditions...)
	}
	session.Status.ObservedGeneration = session.Generation
	meta.SetStatusCondition(&session.Status.Conditions, condition("HostReady", metav1.ConditionTrue, "HostResolved", "referenced T4ClusterHost is available", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("WorkspaceReady", metav1.ConditionTrue, "PVCBoundRWX", "workspace PVC is Bound and ReadWriteMany", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("RuntimeConfigured", metav1.ConditionTrue, "OMPReferencesReady", "administrator-owned OMP runtime references are configured", session.Generation))
	fencedStatus := metav1.ConditionUnknown
	fencedReason := "FencePending"
	fencedMessage := "writer fence state is still converging"
	if session.Status.FenceState == clusterv1alpha1.RuntimeFenceNoPriorWriter || session.Status.FenceState == clusterv1alpha1.RuntimeFenceProven {
		fencedStatus = metav1.ConditionTrue
		fencedReason = "FenceProven"
		fencedMessage = "no older writer can overlap the pending workload"
	} else if session.Status.FenceState == clusterv1alpha1.RuntimeFenceUncertain {
		fencedStatus = metav1.ConditionFalse
		fencedReason = "FenceUncertain"
		fencedMessage = "writer fence evidence is uncertain"
	}
	meta.SetStatusCondition(&session.Status.Conditions, condition("Fenced", fencedStatus, fencedReason, fencedMessage, session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("StorageReady", metav1.ConditionUnknown, "Pending", "runtime-state attachment readiness is pending", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("RouteReady", metav1.ConditionFalse, reason, message, session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("TicketsRevoked", metav1.ConditionTrue, "NoTicketIssuer", "no Kubernetes ticket issuer exists before P2-06", session.Generation))
	authStatus := metav1.ConditionUnknown
	authReason := "GenerationAuthPending"
	authMessage := "generation authentication has not been committed"
	if session.Status.GenerationSecretName != "" {
		authStatus = metav1.ConditionFalse
		authReason = "GenerationAuthActive"
		authMessage = "current generation authentication is active while startup converges"
	}
	meta.SetStatusCondition(&session.Status.Conditions, condition("GenerationAuthRevoked", authStatus, authReason, authMessage, session.Generation))
	session.Status.PodName = podName
	session.Status.ServiceName = serviceName
	session.Status.Phase = clusterv1alpha1.InfrastructurePending
	meta.SetStatusCondition(&session.Status.Conditions, condition("Available", metav1.ConditionFalse, reason, message, session.Generation))
	if reflect.DeepEqual(original, session.Status) {
		return nil
	}
	return r.Status().Update(ctx, session)
}

func (r *SessionReconciler) reconcileDelete(ctx context.Context, session *clusterv1alpha1.T4Session) (ctrl.Result, error) {
	if !controllerutil.ContainsFinalizer(session, clusterv1alpha1.SessionFinalizer) {
		return ctrl.Result{}, nil
	}
	if session.Status.FenceState == clusterv1alpha1.RuntimeFenceUncertain {
		return ctrl.Result{}, nil
	}
	reader := r.authoritativeReader()
	var pod corev1.Pod
	podErr := reader.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: SessionPodName(session)}, &pod)
	if podErr != nil && !apierrors.IsNotFound(podErr) {
		return ctrl.Result{}, podErr
	}
	var service corev1.Service
	serviceErr := reader.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: SessionServiceName(session)}, &service)
	if serviceErr != nil && !apierrors.IsNotFound(serviceErr) {
		return ctrl.Result{}, serviceErr
	}
	if pod.Name != "" && !sessionExclusivelyOwnsResource(&pod, session) ||
		service.Name != "" && !sessionExclusivelyOwnsResource(&service, session) {
		err := r.deleteOwnedSessionResourcesWithFailure(ctx, reader, session, true, false, false, "CleanupOwnershipConflict", "deterministic session workload has an unexpected owner")
		if errors.Is(err, errSessionResourceOwnershipConflict) {
			return ctrl.Result{RequeueAfter: 30 * time.Second}, nil
		}
		return ctrl.Result{}, err
	}
	if pod.Name != "" || len(service.Spec.Selector) != 0 || session.Status.GenerationSecretName != "" &&
		session.Status.FenceState != clusterv1alpha1.RuntimeFenceShutdownRequested {
		if err := r.beginGenerationDrain(ctx, session, &pod, &service, "Terminating", "session is draining and fencing before finalizer progress"); err != nil {
			return ctrl.Result{}, err
		}
		if service.Name != "" {
			if err := deleteWithPreconditions(ctx, r.Client, &service); err != nil && !apierrors.IsNotFound(err) {
				return ctrl.Result{}, err
			}
		}
		return ctrl.Result{RequeueAfter: time.Second}, nil
	}
	var pvc corev1.PersistentVolumeClaim
	if session.Status.RuntimeStatePVCName != "" {
		err := reader.Get(ctx, types.NamespacedName{Namespace: session.Namespace, Name: session.Status.RuntimeStatePVCName}, &pvc)
		if err != nil && !apierrors.IsNotFound(err) {
			return ctrl.Result{}, err
		}
	}
	if session.Status.FenceState == clusterv1alpha1.RuntimeFenceShutdownRequested {
		if err := r.enterFenceVerifying(ctx, session); err != nil {
			return ctrl.Result{}, err
		}
	}
	proven, reason, message, err := r.positiveFenceProof(ctx, session, &pvc)
	if err != nil {
		return ctrl.Result{}, err
	}
	if !proven {
		if err := r.publishFenceUncertain(ctx, session, reason, message); err != nil {
			return ctrl.Result{}, err
		}
		return ctrl.Result{}, nil
	}
	if service.Name != "" {
		if err := deleteWithPreconditions(ctx, r.Client, &service); err != nil && !apierrors.IsNotFound(err) {
			return ctrl.Result{}, err
		}
		return ctrl.Result{RequeueAfter: time.Second}, nil
	}
	accessRemaining, err := r.deleteSessionAccess(ctx, session)
	if err != nil {
		return ctrl.Result{}, err
	}
	if accessRemaining {
		return ctrl.Result{RequeueAfter: time.Second}, nil
	}
	controllerutil.RemoveFinalizer(session, clusterv1alpha1.SessionFinalizer)
	return ctrl.Result{}, r.Update(ctx, session)
}

func (r *SessionReconciler) deleteSessionAccess(ctx context.Context, session *clusterv1alpha1.T4Session) (bool, error) {
	reader := r.authoritativeReader()
	objects := []client.Object{
		&corev1.ServiceAccount{ObjectMeta: metav1.ObjectMeta{Name: SessionServiceAccountName(session), Namespace: session.Namespace}},
		&rbacv1.Role{ObjectMeta: metav1.ObjectMeta{Name: SessionWriterRoleName(session), Namespace: session.Namespace}},
		&rbacv1.RoleBinding{ObjectMeta: metav1.ObjectMeta{Name: SessionWriterRoleBindingName(session), Namespace: session.Namespace}},
	}
	remaining := false
	for _, object := range objects {
		if err := reader.Get(ctx, client.ObjectKeyFromObject(object), object); err != nil {
			if apierrors.IsNotFound(err) {
				continue
			}
			return false, err
		}
		if !sessionExclusivelyOwnsResource(object, session) {
			return false, errSessionResourceOwnershipConflict
		}
		remaining = true
		if object.GetDeletionTimestamp().IsZero() {
			if err := deleteWithPreconditions(ctx, r.Client, object); err != nil && !apierrors.IsNotFound(err) {
				return false, err
			}
		}
	}
	var tokenBinding rbacv1.ClusterRoleBinding
	if err := reader.Get(ctx, types.NamespacedName{Name: SessionTokenReviewBindingName(session)}, &tokenBinding); err == nil {
		if tokenBinding.Annotations["cluster.t4.dev/session-uid"] != string(session.UID) ||
			tokenBinding.Annotations["cluster.t4.dev/session-name"] != session.Name ||
			tokenBinding.Annotations["cluster.t4.dev/session-namespace"] != session.Namespace {
			return false, errSessionResourceOwnershipConflict
		}
		remaining = true
		if tokenBinding.DeletionTimestamp.IsZero() {
			if err := deleteWithPreconditions(ctx, r.Client, &tokenBinding); err != nil && !apierrors.IsNotFound(err) {
				return false, err
			}
		}
	} else if !apierrors.IsNotFound(err) {
		return false, err
	}
	return remaining, nil
}

func (r *SessionReconciler) deleteOwnedSessionResources(ctx context.Context, session *clusterv1alpha1.T4Session) error {
	reader := r.APIReader
	if reader == nil {
		reader = r.Client
	}
	return r.deleteOwnedSessionResourcesWithFailure(ctx, reader, session, true, false, false, "ResourceOwnershipConflict", "one or more deterministic session resources have an unexpected owner")
}

func (r *SessionReconciler) deleteOwnedSessionResourcesAfterVerifiedDependencies(ctx context.Context, session *clusterv1alpha1.T4Session, reason, message string) error {
	reader := r.APIReader
	if reader == nil {
		reader = r.Client
	}
	return r.deleteOwnedSessionResourcesWithFailure(ctx, reader, session, false, true, true, reason, message)
}

func (r *SessionReconciler) deleteOwnedSessionResourcesWithFailure(ctx context.Context, reader client.Reader, session *clusterv1alpha1.T4Session, deleteWithoutConflict, hostReady, workspaceReady bool, reason, message string) error {
	objects := []client.Object{
		&corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: SessionPodName(session), Namespace: session.Namespace}},
		&corev1.Service{ObjectMeta: metav1.ObjectMeta{Name: SessionServiceName(session), Namespace: session.Namespace}},
	}
	owned := make([]client.Object, 0, len(objects))
	ownershipConflict := false
	for _, object := range objects {
		if err := reader.Get(ctx, client.ObjectKeyFromObject(object), object); err != nil {
			if err := client.IgnoreNotFound(err); err != nil {
				return err
			}
			continue
		}
		if !sessionExclusivelyOwnsResource(object, session) {
			ownershipConflict = true
			continue
		}
		owned = append(owned, object)
	}
	if !ownershipConflict && deleteWithoutConflict && len(owned) > 0 {
		var pod corev1.Pod
		var service corev1.Service
		for _, object := range owned {
			switch value := object.(type) {
			case *corev1.Pod:
				pod = *value
			case *corev1.Service:
				service = *value
			}
		}
		if err := r.beginGenerationDrain(ctx, session, &pod, &service, reason, message); err != nil {
			return err
		}
		if service.Name != "" {
			if err := deleteWithPreconditions(ctx, r.Client, &service); err != nil && !apierrors.IsNotFound(err) {
				return err
			}
		}
		return nil
	}
	if !ownershipConflict && len(owned) == 0 {
		_, err := r.deleteSessionAccess(ctx, session)
		return err
	}
	if ownershipConflict {
		for _, object := range owned {
			service, ok := object.(*corev1.Service)
			if !ok || len(service.Spec.Selector) == 0 {
				continue
			}
			service.Spec.Selector = nil
			if err := r.Update(ctx, service); err != nil {
				return err
			}
		}
		authRevoked := session.Status.GenerationSecretName == ""
		if session.Status.GenerationSecretName != "" {
			var secret corev1.Secret
			key := types.NamespacedName{Namespace: session.Namespace, Name: session.Status.GenerationSecretName}
			if err := reader.Get(ctx, key, &secret); err == nil {
				if sessionExclusivelyOwnsResource(&secret, session) {
					if err := deleteWithPreconditions(ctx, r.Client, &secret); err != nil && !apierrors.IsNotFound(err) {
						return err
					}
					authRevoked = true
				}
			} else if apierrors.IsNotFound(err) {
				authRevoked = true
			} else {
				return err
			}
		}
		var lease coordinationv1.Lease
		leaseKey := types.NamespacedName{Namespace: session.Namespace, Name: SessionWriterLeaseName(session)}
		if err := reader.Get(ctx, leaseKey, &lease); err == nil {
			if sessionExclusivelyOwnsResource(&lease, session) {
				if err := deleteWithPreconditions(ctx, r.Client, &lease); err != nil && !apierrors.IsNotFound(err) {
					return err
				}
			}
		} else if !apierrors.IsNotFound(err) {
			return err
		}
		if deleteWithoutConflict {
			for _, object := range owned {
				if err := deleteWithPreconditions(ctx, r.Client, object); err != nil && !apierrors.IsNotFound(err) {
					return err
				}
			}
		}
		if authRevoked {
			meta.SetStatusCondition(&session.Status.Conditions, condition("GenerationAuthRevoked", metav1.ConditionTrue, "GenerationAuthDeleted", "owned generation authentication is revoked after an ownership conflict", session.Generation))
		}
		if err := r.publishFenceUncertain(ctx, session, reason, message); err != nil {
			return err
		}
		return errSessionResourceOwnershipConflict
	}
	return nil
}

func deleteWithPreconditions(ctx context.Context, writer client.Client, object client.Object) error {
	preconditions := metav1.Preconditions{}
	if uid := object.GetUID(); uid != "" {
		preconditions.UID = &uid
	}
	if resourceVersion := object.GetResourceVersion(); resourceVersion != "" {
		preconditions.ResourceVersion = &resourceVersion
	}
	options := &client.DeleteOptions{}
	if preconditions.UID != nil || preconditions.ResourceVersion != nil {
		options.Preconditions = &preconditions
	}
	return writer.Delete(ctx, object, options)
}

func (r *SessionReconciler) updateSessionFailure(ctx context.Context, session *clusterv1alpha1.T4Session, hostReady, workspaceReady bool, conditionType, reason, message string) error {
	original := session.Status
	if session.Status.Conditions != nil {
		original.Conditions = append([]metav1.Condition(nil), session.Status.Conditions...)
	}
	if conditionType == "HostReady" {
		meta.SetStatusCondition(&session.Status.Conditions, condition("HostReady", metav1.ConditionFalse, reason, message, session.Generation))
	} else if hostReady {
		meta.SetStatusCondition(&session.Status.Conditions, condition("HostReady", metav1.ConditionTrue, "HostResolved", "referenced T4ClusterHost is available", session.Generation))
	} else {
		meta.SetStatusCondition(&session.Status.Conditions, condition("HostReady", metav1.ConditionUnknown, "NotEvaluated", "host dependency was not evaluated", session.Generation))
	}
	if conditionType == "WorkspaceReady" {
		meta.SetStatusCondition(&session.Status.Conditions, condition("WorkspaceReady", metav1.ConditionFalse, reason, message, session.Generation))
	} else if workspaceReady {
		meta.SetStatusCondition(&session.Status.Conditions, condition("WorkspaceReady", metav1.ConditionTrue, "PVCBoundRWX", "workspace PVC is Bound and ReadWriteMany", session.Generation))
	} else {
		meta.SetStatusCondition(&session.Status.Conditions, condition("WorkspaceReady", metav1.ConditionUnknown, "NotEvaluated", "workspace dependency was not evaluated", session.Generation))
	}
	if conditionType == "RuntimeConfigured" {
		meta.SetStatusCondition(&session.Status.Conditions, condition("RuntimeConfigured", metav1.ConditionFalse, reason, message, session.Generation))
	} else if workspaceReady {
		meta.SetStatusCondition(&session.Status.Conditions, condition("RuntimeConfigured", metav1.ConditionTrue, "OMPReferencesReady", "administrator-owned OMP runtime references are configured", session.Generation))
	} else {
		meta.SetStatusCondition(&session.Status.Conditions, condition("RuntimeConfigured", metav1.ConditionUnknown, "NotEvaluated", "runtime configuration was not evaluated", session.Generation))
	}
	fencedStatus := metav1.ConditionUnknown
	fencedReason := "FenceNotEvaluated"
	fencedMessage := "writer fence was not fully evaluated on this failure path"
	switch session.Status.FenceState {
	case clusterv1alpha1.RuntimeFenceNoPriorWriter, clusterv1alpha1.RuntimeFenceProven:
		fencedStatus = metav1.ConditionTrue
		fencedReason = "FenceProven"
		fencedMessage = "no older writer is authorized"
	case clusterv1alpha1.RuntimeFenceUncertain:
		fencedStatus = metav1.ConditionFalse
		fencedReason = "FenceUncertain"
		fencedMessage = "writer fence evidence is uncertain"
	}
	meta.SetStatusCondition(&session.Status.Conditions, condition("Fenced", fencedStatus, fencedReason, fencedMessage, session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("StorageReady", metav1.ConditionUnknown, "NotEvaluated", "runtime-state attachment readiness was not established", session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("RouteReady", metav1.ConditionFalse, reason, message, session.Generation))
	meta.SetStatusCondition(&session.Status.Conditions, condition("TicketsRevoked", metav1.ConditionTrue, "NoTicketIssuer", "no Kubernetes ticket issuer exists before P2-06", session.Generation))
	authStatus := metav1.ConditionUnknown
	authReason := "GenerationAuthRevocationPending"
	authMessage := "generation authentication absence has not been proven"
	if session.Status.GenerationSecretName == "" {
		authStatus = metav1.ConditionTrue
		authReason = "NoGenerationAuth"
		authMessage = "no generation authentication resource was committed"
	} else if revoked := meta.FindStatusCondition(session.Status.Conditions, "GenerationAuthRevoked"); revoked != nil && revoked.Status == metav1.ConditionTrue {
		authStatus = metav1.ConditionTrue
		authReason = revoked.Reason
		authMessage = revoked.Message
	}
	meta.SetStatusCondition(&session.Status.Conditions, condition("GenerationAuthRevoked", authStatus, authReason, authMessage, session.Generation))
	session.Status.ObservedGeneration = session.Generation
	session.Status.PodName = ""
	session.Status.ServiceName = ""
	session.Status.Phase = clusterv1alpha1.InfrastructureFailed
	meta.SetStatusCondition(&session.Status.Conditions, condition("Available", metav1.ConditionFalse, reason, message, session.Generation))
	if reflect.DeepEqual(original, session.Status) {
		return nil
	}
	return r.Status().Update(ctx, session)
}

func sessionExclusivelyOwnsResource(object metav1.Object, session *clusterv1alpha1.T4Session) bool {
	controller := metav1.GetControllerOf(object)
	if controller == nil || controller.APIVersion != clusterv1alpha1.GroupVersion.String() || controller.Kind != "T4Session" || controller.Name != session.Name || controller.UID != session.UID {
		return false
	}
	for _, reference := range object.GetOwnerReferences() {
		if reference.APIVersion != clusterv1alpha1.GroupVersion.String() || reference.Kind != "T4Session" || reference.Name != session.Name || reference.UID != session.UID {
			return false
		}
	}
	return true
}

func serviceExposureIsInternal(service *corev1.Service) bool {
	if service.Spec.Type != corev1.ServiceTypeClusterIP || service.Spec.ClusterIP == corev1.ClusterIPNone || service.Spec.ExternalName != "" ||
		len(service.Spec.ExternalIPs) != 0 || service.Spec.LoadBalancerIP != "" || len(service.Spec.LoadBalancerSourceRanges) != 0 ||
		service.Spec.LoadBalancerClass != nil || service.Spec.HealthCheckNodePort != 0 || service.Spec.AllocateLoadBalancerNodePorts != nil {
		return false
	}
	for _, port := range service.Spec.Ports {
		if port.NodePort != 0 {
			return false
		}
	}
	return true
}

func labelsContain(actual, required map[string]string) bool {
	for key, value := range required {
		if actual[key] != value {
			return false
		}
	}
	return true
}
func indexSessionByHostRef(object client.Object) []string {
	session, ok := object.(*clusterv1alpha1.T4Session)
	if !ok || session.Spec.HostRef == "" {
		return nil
	}
	return []string{session.Spec.HostRef}
}

func indexSessionByWorkspaceRef(object client.Object) []string {
	session, ok := object.(*clusterv1alpha1.T4Session)
	if !ok || session.Spec.WorkspaceRef == "" {
		return nil
	}
	return []string{session.Spec.WorkspaceRef}
}

func (r *SessionReconciler) sessionRequestsForHost(ctx context.Context, object client.Object) []ctrl.Request {
	host, ok := object.(*clusterv1alpha1.T4ClusterHost)
	if !ok || host.Name == "" || host.Namespace == "" {
		return nil
	}
	return r.sessionRequestsForReference(ctx, host.Namespace, sessionHostRefIndexField, host.Name, "clusterHost", client.ObjectKeyFromObject(host))
}

func (r *SessionReconciler) sessionRequestsForWorkspace(ctx context.Context, object client.Object) []ctrl.Request {
	workspace, ok := object.(*clusterv1alpha1.T4Workspace)
	if !ok || workspace.Name == "" || workspace.Namespace == "" {
		return nil
	}
	return r.sessionRequestsForReference(ctx, workspace.Namespace, sessionWorkspaceRefIndexField, workspace.Name, "workspace", client.ObjectKeyFromObject(workspace))
}

func (r *SessionReconciler) sessionRequestsForReference(ctx context.Context, namespace, field, value, dependencyKind string, dependencyKey types.NamespacedName) []ctrl.Request {
	var sessions clusterv1alpha1.T4SessionList
	if err := r.List(ctx, &sessions, client.InNamespace(namespace), client.MatchingFields{field: value}); err != nil {
		ctrl.LoggerFrom(ctx).Error(err, "unable to map dependency to sessions", dependencyKind, dependencyKey)
		return nil
	}
	requests := make([]ctrl.Request, 0, len(sessions.Items))
	for i := range sessions.Items {
		requests = append(requests, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(&sessions.Items[i])})
	}
	return requests
}

func (r *SessionReconciler) sessionRequestsForVolumeAttachment(ctx context.Context, object client.Object) []ctrl.Request {
	attachment, ok := object.(*storagev1.VolumeAttachment)
	if !ok || attachment.Spec.Source.PersistentVolumeName == nil {
		return nil
	}
	var volume corev1.PersistentVolume
	if err := r.Get(ctx, types.NamespacedName{Name: *attachment.Spec.Source.PersistentVolumeName}, &volume); err != nil ||
		volume.Spec.ClaimRef == nil || volume.Spec.ClaimRef.Namespace == "" || volume.Spec.ClaimRef.Name == "" {
		return nil
	}
	var sessions clusterv1alpha1.T4SessionList
	if err := r.List(ctx, &sessions, client.InNamespace(volume.Spec.ClaimRef.Namespace)); err != nil {
		ctrl.LoggerFrom(ctx).Error(err, "unable to map VolumeAttachment to sessions", "volumeAttachment", attachment.Name)
		return nil
	}
	requests := make([]ctrl.Request, 0, 1)
	for index := range sessions.Items {
		if sessions.Items[index].Status.RuntimeStatePVCName == volume.Spec.ClaimRef.Name {
			requests = append(requests, ctrl.Request{NamespacedName: client.ObjectKeyFromObject(&sessions.Items[index])})
		}
	}
	return requests
}

func (r *SessionReconciler) SetupWithManager(manager ctrl.Manager) error {
	if err := manager.GetFieldIndexer().IndexField(context.Background(), &clusterv1alpha1.T4Session{}, sessionHostRefIndexField, indexSessionByHostRef); err != nil {
		return fmt.Errorf("index T4Session by host reference: %w", err)
	}
	if err := manager.GetFieldIndexer().IndexField(context.Background(), &clusterv1alpha1.T4Session{}, sessionWorkspaceRefIndexField, indexSessionByWorkspaceRef); err != nil {
		return fmt.Errorf("index T4Session by workspace reference: %w", err)
	}
	return ctrl.NewControllerManagedBy(manager).
		For(&clusterv1alpha1.T4Session{}).
		Watches(&clusterv1alpha1.T4ClusterHost{}, handler.EnqueueRequestsFromMapFunc(r.sessionRequestsForHost)).
		Watches(&clusterv1alpha1.T4Workspace{}, handler.EnqueueRequestsFromMapFunc(r.sessionRequestsForWorkspace)).
		Watches(&storagev1.VolumeAttachment{}, handler.EnqueueRequestsFromMapFunc(r.sessionRequestsForVolumeAttachment)).
		Owns(&corev1.Pod{}).
		Owns(&corev1.Service{}).
		Owns(&corev1.Secret{}).
		Owns(&coordinationv1.Lease{}).
		Owns(&corev1.PersistentVolumeClaim{}).
		Complete(r)
}

func podReady(pod *corev1.Pod) bool {
	if !pod.DeletionTimestamp.IsZero() {
		return false
	}
	for _, item := range pod.Status.Conditions {
		if item.Type == corev1.PodReady {
			return item.Status == corev1.ConditionTrue
		}
	}
	return false
}

func ptrQuantity(value apiresource.Quantity) *apiresource.Quantity { return &value }
func ptr[T any](value T) *T                                        { return &value }
