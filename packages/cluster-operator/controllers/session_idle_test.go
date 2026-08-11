package controllers

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	apierrors "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/runtime/schema"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
	"sigs.k8s.io/controller-runtime/pkg/client/fake"

	clusterv1alpha1 "github.com/wolfiesch/omperator/packages/cluster-operator/api/v1alpha1"
)

type fakeRuntimeLifecycle struct {
	activity    RuntimeActivitySnapshot
	activityErr error
	ack         RuntimeShutdownAck
	drainErr    error
	drains      int
	quiesces int
	reopens   int
	reopenErr error
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (roundTrip roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return roundTrip(request)
}

func (runtime *fakeRuntimeLifecycle) Activity(context.Context, *clusterv1alpha1.T4Session, *corev1.Pod) (RuntimeActivitySnapshot, error) {
	return runtime.activity, runtime.activityErr
}
func (runtime *fakeRuntimeLifecycle) DrainIfIdle(context.Context, *clusterv1alpha1.T4Session, *corev1.Pod) (RuntimeShutdownAck, error) {
	runtime.drains++
	return runtime.ack, runtime.drainErr
}
func (runtime *fakeRuntimeLifecycle) Quiesce(context.Context, *clusterv1alpha1.T4Session, *corev1.Pod) (RuntimeShutdownAck, error) {
	runtime.quiesces++
	return runtime.ack, runtime.drainErr
}
func (runtime *fakeRuntimeLifecycle) Reopen(context.Context, *clusterv1alpha1.T4Session, *corev1.Pod) error {
	runtime.reopens++
	return runtime.reopenErr
}

type conflictSessionUpdateClient struct {
	client.Client
}

func (store *conflictSessionUpdateClient) Update(ctx context.Context, object client.Object, options ...client.UpdateOption) error {
	if _, ok := object.(*clusterv1alpha1.T4Session); ok {
		return apierrors.NewConflict(schema.GroupResource{Resource: "t4sessions"}, object.GetName(), errors.New("desired state changed"))
	}
	return store.Client.Update(ctx, object, options...)
}
type responseLostSessionUpdateClient struct {
	client.Client
}

func (store *responseLostSessionUpdateClient) Update(ctx context.Context, object client.Object, options ...client.UpdateOption) error {
	if _, ok := object.(*clusterv1alpha1.T4Session); ok {
		object.SetGeneration(object.GetGeneration() + 1)
		if err := store.Client.Update(ctx, object, options...); err != nil {
			return err
		}
		return errors.New("update response lost")
	}
	return store.Client.Update(ctx, object, options...)
}


func inactiveActivity() RuntimeActivitySnapshot {
	return RuntimeActivitySnapshot{SchemaVersion: 1, Policy: "allow-idle-sleep"}
}

func idleSessionPod() (*clusterv1alpha1.T4Session, *corev1.Pod) {
	idleSeconds := int32(60)
	session := &clusterv1alpha1.T4Session{
		ObjectMeta: metav1.ObjectMeta{Name: "idle-session", Namespace: "team", UID: "runtime-uid"},
		Spec:       clusterv1alpha1.T4SessionSpec{DesiredState: clusterv1alpha1.DesiredStateRunning, IdlePolicy: &clusterv1alpha1.IdlePolicy{Enabled: true, IdleSeconds: &idleSeconds}},
		Status:     clusterv1alpha1.T4SessionStatus{RuntimeGeneration: "gen_abcdefghijklmnopqrstuvwx"},
	}
	pod := &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: SessionPodName(session), Namespace: session.Namespace, Annotations: map[string]string{}}}
	return session, pod
}

func TestSessionIdleActivitySignalsIndependentlyResetWindow(t *testing.T) {
	signalMutators := map[string]func(*RuntimeActivitySignals){
		"clients":              func(s *RuntimeActivitySignals) { s.Clients = 1 },
		"turns":                func(s *RuntimeActivitySignals) { s.OMPTurns = 1 },
		"retries":              func(s *RuntimeActivitySignals) { s.OMPRetries = 1 },
		"compaction":           func(s *RuntimeActivitySignals) { s.OMPCompactions = 1 },
		"bash":                 func(s *RuntimeActivitySignals) { s.BashCommands = 1 },
		"jobs":                 func(s *RuntimeActivitySignals) { s.Jobs = 1 },
		"tasks":                func(s *RuntimeActivitySignals) { s.Tasks = 1 },
		"approvals":            func(s *RuntimeActivitySignals) { s.Approvals = 1 },
		"ui":                   func(s *RuntimeActivitySignals) { s.UIPending = 1 },
		"terminal-connections": func(s *RuntimeActivitySignals) { s.TerminalConnections = 1 },
		"terminal-leases":      func(s *RuntimeActivitySignals) { s.TerminalLeases = 1 },
		"browser-previews":     func(s *RuntimeActivitySignals) { s.BrowserPreviews = 1 },
		"browser-leases":       func(s *RuntimeActivitySignals) { s.BrowserLeases = 1 },
		"gateway":              func(s *RuntimeActivitySignals) { s.GatewayUpstreams = 1 },
	}
	for name, mutate := range signalMutators {
		t.Run(name, func(t *testing.T) {
			session, pod := idleSessionPod()
			pod.Annotations[sessionIdleSinceAnnotation] = "2026-07-30T00:00:00Z"
			pod.Annotations[sessionIdleGenerationAnnotation] = session.Status.RuntimeGeneration
			activity := inactiveActivity()
			mutate(&activity.Signals)
			activity.Active = true
			runtimeClient := &fakeRuntimeLifecycle{activity: activity}
			scheme := runtime.NewScheme()
			_ = corev1.AddToScheme(scheme)
			_ = clusterv1alpha1.AddToScheme(scheme)
			client := fake.NewClientBuilder().WithScheme(scheme).WithObjects(session, pod).Build()
			reconciler := &SessionReconciler{Client: client, RuntimeLifecycle: runtimeClient, Now: func() time.Time { return time.Date(2026, 7, 30, 1, 0, 0, 0, time.UTC) }}
			result, handled, err := reconciler.reconcileIdleSleep(t.Context(), session, pod)
			if err != nil || !handled || result.RequeueAfter != runtimeActivityPollInterval || runtimeClient.drains != 0 {
				t.Fatalf("idle activity result=%+v handled=%t drains=%d err=%v", result, handled, runtimeClient.drains, err)
			}
			if pod.Annotations[sessionIdleSinceAnnotation] != "" {
				t.Fatal("active signal did not clear idle window")
			}
		})
	}
}

func TestSessionIdleDrainRequiresGenerationBoundDurableAck(t *testing.T) {
	for name, runtimeClient := range map[string]*fakeRuntimeLifecycle{
		"flush-failure":    {activity: inactiveActivity(), drainErr: errors.New("flush failed")},
		"stale-generation": {activity: inactiveActivity(), ack: RuntimeShutdownAck{SchemaVersion: 1, Generation: "stale", Durable: true}},
		"non-durable":      {activity: inactiveActivity(), ack: RuntimeShutdownAck{SchemaVersion: 1, Generation: "gen_abcdefghijklmnopqrstuvwx"}},
	} {
		t.Run(name, func(t *testing.T) {
			session, pod := idleSessionPod()
			now := time.Date(2026, 7, 30, 1, 0, 0, 0, time.UTC)
			pod.Annotations[sessionIdleSinceAnnotation] = now.Add(-61 * time.Second).Format(time.RFC3339Nano)
			pod.Annotations[sessionIdleGenerationAnnotation] = session.Status.RuntimeGeneration
			scheme := runtime.NewScheme()
			_ = corev1.AddToScheme(scheme)
			_ = clusterv1alpha1.AddToScheme(scheme)
			client := fake.NewClientBuilder().WithScheme(scheme).WithObjects(session, pod).Build()
			reconciler := &SessionReconciler{Client: client, RuntimeLifecycle: runtimeClient, Now: func() time.Time { return now }}
			result, handled, err := reconciler.reconcileIdleSleep(t.Context(), session, pod)
			if err != nil || !handled || result.RequeueAfter != runtimeActivityPollInterval {
				t.Fatalf("failed drain result=%+v handled=%t err=%v", result, handled, err)
			}
			var stored corev1.Pod
			if err := client.Get(t.Context(), types.NamespacedName{Namespace: pod.Namespace, Name: pod.Name}, &stored); err != nil {
				t.Fatal(err)
			}
			if stored.DeletionTimestamp != nil {
				t.Fatal("failed flush removed running pod")
			}
		})
	}

	session, pod := idleSessionPod()
	now := time.Date(2026, 7, 30, 1, 0, 0, 0, time.UTC)
	pod.Annotations[sessionIdleSinceAnnotation] = now.Add(-61 * time.Second).Format(time.RFC3339Nano)
	pod.Annotations[sessionIdleGenerationAnnotation] = session.Status.RuntimeGeneration
	runtimeClient := &fakeRuntimeLifecycle{activity: inactiveActivity(), ack: RuntimeShutdownAck{SchemaVersion: 1, Generation: session.Status.RuntimeGeneration, Durable: true}}
	scheme := runtime.NewScheme()
	_ = corev1.AddToScheme(scheme)
	_ = clusterv1alpha1.AddToScheme(scheme)
	client := fake.NewClientBuilder().WithScheme(scheme).WithObjects(session, pod).Build()
	reconciler := &SessionReconciler{Client: client, RuntimeLifecycle: runtimeClient, Now: func() time.Time { return now }}
	if _, handled, err := reconciler.reconcileIdleSleep(t.Context(), session, pod); err != nil || !handled {
		t.Fatalf("acknowledged drain handled=%t err=%v", handled, err)
	}
	var stored clusterv1alpha1.T4Session
	if err := client.Get(t.Context(), types.NamespacedName{Namespace: session.Namespace, Name: session.Name}, &stored); err != nil {
		t.Fatal(err)
	}
	if stored.Spec.DesiredState != clusterv1alpha1.DesiredStateSleeping {
		t.Fatalf("desired state=%q, want Sleeping", stored.Spec.DesiredState)
	}
}

func TestSessionIdleDrainReopensAfterDesiredStateConflictDespiteLeaderCancellation(t *testing.T) {
	session, pod := idleSessionPod()
	now := time.Date(2026, 7, 30, 1, 0, 0, 0, time.UTC)
	pod.Annotations[sessionIdleSinceAnnotation] = now.Add(-61 * time.Second).Format(time.RFC3339Nano)
	pod.Annotations[sessionIdleGenerationAnnotation] = session.Status.RuntimeGeneration
	runtimeClient := &fakeRuntimeLifecycle{
		activity: inactiveActivity(),
		ack:      RuntimeShutdownAck{SchemaVersion: 1, Generation: session.Status.RuntimeGeneration, Durable: true},
	}
	scheme := runtime.NewScheme()
	_ = corev1.AddToScheme(scheme)
	_ = clusterv1alpha1.AddToScheme(scheme)
	base := fake.NewClientBuilder().WithScheme(scheme).WithObjects(session, pod).Build()
	store := &conflictSessionUpdateClient{Client: base}
	reconciler := &SessionReconciler{Client: store, RuntimeLifecycle: runtimeClient, Now: func() time.Time { return now }}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, handled, err := reconciler.reconcileIdleSleep(ctx, session, pod); err == nil || !handled {
		t.Fatalf("conflicting auto-sleep handled=%t err=%v", handled, err)
	}
	if runtimeClient.reopens != 1 {
		t.Fatalf("reopen calls=%d, want 1", runtimeClient.reopens)
	}
}

func TestSessionIdleDrainCompletesCommittedUpdateAfterResponseLoss(t *testing.T) {
	session, pod := idleSessionPod()
	now := time.Date(2026, 7, 30, 1, 0, 0, 0, time.UTC)
	pod.Annotations[sessionIdleSinceAnnotation] = now.Add(-61 * time.Second).Format(time.RFC3339Nano)
	pod.Annotations[sessionIdleGenerationAnnotation] = session.Status.RuntimeGeneration
	runtimeClient := &fakeRuntimeLifecycle{
		activity: inactiveActivity(),
		ack:      RuntimeShutdownAck{SchemaVersion: 1, Generation: session.Status.RuntimeGeneration, Durable: true},
	}
	scheme := runtime.NewScheme()
	_ = corev1.AddToScheme(scheme)
	_ = clusterv1alpha1.AddToScheme(scheme)
	base := fake.NewClientBuilder().WithScheme(scheme).WithObjects(session, pod).Build()
	store := &responseLostSessionUpdateClient{Client: base}
	reconciler := &SessionReconciler{Client: store, APIReader: base, RuntimeLifecycle: runtimeClient, Now: func() time.Time { return now }}
	if result, handled, err := reconciler.reconcileIdleSleep(t.Context(), session, pod); err != nil || !handled || !result.Requeue {
		t.Fatalf("committed auto-sleep result=%+v handled=%t err=%v", result, handled, err)
	}
	if runtimeClient.reopens != 0 {
		t.Fatalf("committed auto-sleep reopened ingress %d times", runtimeClient.reopens)
	}
	var stored clusterv1alpha1.T4Session
	if err := base.Get(t.Context(), types.NamespacedName{Namespace: session.Namespace, Name: session.Name}, &stored); err != nil {
		t.Fatal(err)
	}
	if stored.Spec.DesiredState != clusterv1alpha1.DesiredStateSleeping {
		t.Fatalf("desired state=%q, want Sleeping", stored.Spec.DesiredState)
	}
}

func TestExplicitInactiveUsesQuiesceAndConvergesFromActive(t *testing.T) {
	for _, desired := range []clusterv1alpha1.DesiredState{clusterv1alpha1.DesiredStateSleeping, clusterv1alpha1.DesiredStateStopped} {
		session, pod := idleSessionPod()
		session.Spec.DesiredState = desired
		session.Status.PodUID = "pod-uid"
		pod.UID = "pod-uid"
		runtimeClient := &fakeRuntimeLifecycle{
			activity: RuntimeActivitySnapshot{SchemaVersion: 1, Active: true, Policy: "allow-idle-sleep", Signals: RuntimeActivitySignals{Clients: 1}},
			ack: RuntimeShutdownAck{SchemaVersion: 1, Generation: session.Status.RuntimeGeneration, Durable: true},
		}
		scheme := runtime.NewScheme()
		_ = corev1.AddToScheme(scheme)
		_ = clusterv1alpha1.AddToScheme(scheme)
		store := fake.NewClientBuilder().WithScheme(scheme).WithObjects(session, pod).Build()
		reconciler := &SessionReconciler{Client: store, RuntimeLifecycle: runtimeClient}
		result, handled, err := reconciler.prepareRequestedInactive(t.Context(), session)
		if err != nil || handled || result.Requeue || result.RequeueAfter != 0 {
			t.Fatalf("desired=%s result=%+v handled=%t err=%v", desired, result, handled, err)
		}
		if runtimeClient.quiesces != 1 || runtimeClient.drains != 0 {
			t.Fatalf("desired=%s quiesces=%d idleDrains=%d", desired, runtimeClient.quiesces, runtimeClient.drains)
		}
	}
}
func TestSessionActivityClientAuthenticatesExactUIDAndGeneration(t *testing.T) {
	session, pod := idleSessionPod()

	session.Status.PodUID = "pod-uid"
	session.Status.GenerationSecretName = "generation-secret"
	pod.UID = "pod-uid"
	pod.Annotations[writerLeaseGenerationAnnotation] = session.Status.RuntimeGeneration
	controller := true
	key := make([]byte, 32)
	for index := range key {
		key[index] = byte(index + 1)
	}
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{
			Name: session.Status.GenerationSecretName, Namespace: session.Namespace,
			OwnerReferences: []metav1.OwnerReference{{APIVersion: clusterv1alpha1.GroupVersion.String(), Kind: "T4Session", Name: session.Name, UID: session.UID, Controller: &controller}},
		},
		Data: map[string][]byte{generationAuthKey: key},
	}
	scheme := runtime.NewScheme()
	_ = corev1.AddToScheme(scheme)
	_ = clusterv1alpha1.AddToScheme(scheme)
	reader := fake.NewClientBuilder().WithScheme(scheme).WithObjects(session, pod, secret).Build()
	var requestBody string
	httpClient := &http.Client{Transport: roundTripFunc(func(request *http.Request) (*http.Response, error) {
		if request.URL.Host != SessionServiceName(session)+"."+session.Namespace+".svc:8788" || request.URL.Path != "/internal/runtime/activity" {
			t.Fatalf("activity URL=%q", request.URL)
		}
		if request.Header.Get("authorization") != "Bearer "+base64.RawURLEncoding.EncodeToString(key) {
			t.Fatal("generation credential was not bound to request")
		}
		bytes, err := io.ReadAll(request.Body)
		if err != nil {
			return nil, err
		}
		requestBody = string(bytes)
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(`{"schemaVersion":1,"active":false,"keepalive":false,"policy":"allow-idle-sleep","signals":{"clients":0,"ompTurns":0,"ompRetries":0,"ompCompactions":0,"bashCommands":0,"jobs":0,"tasks":0,"approvals":0,"uiPending":0,"terminalConnections":0,"terminalLeases":0,"browserPreviews":0,"browserLeases":0,"gatewayUpstreams":0}}`)), Header: make(http.Header)}, nil
	})}
	lifecycle := &KubernetesRuntimeLifecycleClient{Reader: reader, HTTP: httpClient}
	snapshot, err := lifecycle.Activity(t.Context(), session, pod)
	if err != nil || !snapshot.valid() {
		t.Fatalf("activity snapshot=%+v err=%v", snapshot, err)
	}
	if !strings.Contains(requestBody, `"expectedRuntimeUid":"runtime-uid"`) || !strings.Contains(requestBody, `"expectedGeneration":"gen_abcdefghijklmnopqrstuvwx"`) {
		t.Fatalf("activity identity body=%s", requestBody)
	}
	pod.Annotations[writerLeaseGenerationAnnotation] = "stale"
	if _, err := lifecycle.Activity(t.Context(), session, pod); err == nil {
		t.Fatal("stale pod generation was accepted")
	}
}

func TestRuntimeIngressConfigMapReclaimsExpiredLeaseAndGarbageCollectsFencedGeneration(t *testing.T) {
	scheme := runtime.NewScheme()
	_ = corev1.AddToScheme(scheme)
	state := initialControlLedgerState()
	records := []runtimeIngressRecord{{
		RuntimeID:  "runtime-one",
		Generation: "generation-old",
		Open:       false,
		Leases: []runtimeIngressLease{{
			LeaseIDDigest:       strings.Repeat("a", 64),
			GatewayReplicaEpoch: "gateway-dead",
			ExpiresAt:           time.Now().Add(-time.Second).UnixMilli(),
		}},
	}}
	encoded, err := encodeRuntimeIngress(state, records)
	if err != nil {
		t.Fatal(err)
	}
	configMap := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: runtimeControlLedgerName("primary"), Namespace: "team"},
		Data:       map[string]string{"state": encoded},
	}
	store := fake.NewClientBuilder().WithScheme(scheme).WithObjects(configMap).Build()
	ingress, err := readRuntimeIngress(t.Context(), store, "team", "primary", "runtime-one", "generation-old")
	if err != nil || ingress.ActiveLeases != 0 || ingress.Open {
		t.Fatalf("expired ingress=%+v err=%v", ingress, err)
	}
	if _, err := mutateRuntimeIngress(t.Context(), store, "team", "primary", "runtime-one", "generation-current", func(current runtimeIngressState) (runtimeIngressState, bool, error) {
		return runtimeIngressState{Open: false}, true, nil
	}); err != nil {
		t.Fatal(err)
	}
	var stored corev1.ConfigMap
	if err := store.Get(t.Context(), types.NamespacedName{Namespace: "team", Name: runtimeControlLedgerName("primary")}, &stored); err != nil {
		t.Fatal(err)
	}
	_, retained, err := decodeRuntimeIngress(stored.Data["state"])
	if err != nil {
		t.Fatal(err)
	}
	bytes, _ := json.Marshal(retained)
	if len(retained) != 1 || retained[0].Generation != "generation-current" {
		t.Fatalf("retained ingress=%s", bytes)
	}
}

func TestRuntimeIngressReopenPhaseIsResumableWithoutEarlyAdmission(t *testing.T) {
	scheme := runtime.NewScheme()
	_ = corev1.AddToScheme(scheme)
	store := fake.NewClientBuilder().WithScheme(scheme).Build()
	prepare := func(current runtimeIngressState) (runtimeIngressState, bool, error) {
		return runtimeIngressState{Open: false, Reopening: true, ActiveLeases: current.ActiveLeases}, current.Open || !current.Reopening, nil
	}
	if _, err := mutateRuntimeIngress(t.Context(), store, "team", "primary", "runtime-one", "generation-one", prepare); err != nil {
		t.Fatal(err)
	}
	pending, err := readRuntimeIngress(t.Context(), store, "team", "primary", "runtime-one", "generation-one")
	if err != nil || pending.Open || !pending.Reopening {
		t.Fatalf("prepared reopen admitted ingress early: state=%+v err=%v", pending, err)
	}
	if retried, err := mutateRuntimeIngress(t.Context(), store, "team", "primary", "runtime-one", "generation-one", prepare); err != nil || retried.Open || !retried.Reopening {
		t.Fatalf("prepared reopen retry state=%+v err=%v", retried, err)
	}
	if _, err := mutateRuntimeIngress(t.Context(), store, "team", "primary", "runtime-one", "generation-one", func(current runtimeIngressState) (runtimeIngressState, bool, error) {
		return runtimeIngressState{Open: true, Reopening: false, ActiveLeases: current.ActiveLeases}, !current.Open || current.Reopening, nil
	}); err != nil {
		t.Fatal(err)
	}
	complete, err := readRuntimeIngress(t.Context(), store, "team", "primary", "runtime-one", "generation-one")
	if err != nil || !complete.Open || complete.Reopening {
		t.Fatalf("completed reopen state=%+v err=%v", complete, err)
	}
}

func TestControllerRetiresCommittedActivationAfterConfirmedSleep(t *testing.T) {
	scheme := runtime.NewScheme()
	_ = corev1.AddToScheme(scheme)
	state := initialControlLedgerState()
	scopeID := "scope-one"
	runtimeID := "runtime-public"
	digest := sha256.Sum256([]byte(scopeID + "\x00runtime\x00" + runtimeID + "\x00activate"))
	reservations, _ := json.Marshal([]admissionReservationRecord{{
		ResourceDigest: hex.EncodeToString(digest[:]),
		ScopeID:        scopeID,
		ResourceKind:   "runtime",
		Transition:     "activate",
		Committed:      true,
	}})
	state["admissionReservations"] = reservations
	encoded, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	configMap := &corev1.ConfigMap{
		ObjectMeta: metav1.ObjectMeta{Name: runtimeControlLedgerName("primary"), Namespace: "team"},
		Data:       map[string]string{"state": string(encoded)},
	}
	store := fake.NewClientBuilder().WithScheme(scheme).WithObjects(configMap).Build()
	if err := retireRuntimeActivationAdmission(t.Context(), store, "team", "primary", runtimeID, ""); err == nil {
		t.Fatal("missing canonical scope binding was accepted")
	}
	if err := retireRuntimeActivationAdmission(t.Context(), store, "team", "primary", runtimeID, scopeID); err != nil {
		t.Fatal(err)
	}
	var stored corev1.ConfigMap
	if err := store.Get(t.Context(), types.NamespacedName{Namespace: "team", Name: runtimeControlLedgerName("primary")}, &stored); err != nil {
		t.Fatal(err)
	}
	var result map[string]json.RawMessage
	if err := json.Unmarshal([]byte(stored.Data["state"]), &result); err != nil {
		t.Fatal(err)
	}
	var retained []admissionReservationRecord
	if err := json.Unmarshal(result["admissionReservations"], &retained); err != nil {
		t.Fatal(err)
	}
	if len(retained) != 0 {
		t.Fatalf("committed activation was not retired: %+v", retained)
	}
}
