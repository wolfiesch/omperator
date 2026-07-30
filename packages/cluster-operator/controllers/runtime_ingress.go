package controllers

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	"sigs.k8s.io/controller-runtime/pkg/client"
)

type runtimeIngressLease struct {
	LeaseIDDigest       string `json:"leaseIdDigest"`
	GatewayReplicaEpoch string `json:"gatewayReplicaEpoch"`
	ExpiresAt           int64  `json:"expiresAt"`
}

type runtimeIngressRecord struct {
	RuntimeID  string                `json:"runtimeId"`
	Generation string                `json:"generation"`
	Open       bool                  `json:"open"`
	Reopening  bool                  `json:"reopening,omitempty"`
	Leases     []runtimeIngressLease `json:"leases"`
}

type runtimeIngressState struct {
	Open         bool
	Reopening    bool
	ActiveLeases int
	leases       []runtimeIngressLease
}

type admissionReservationRecord struct {
	ResourceDigest string `json:"resourceDigest"`
	ScopeID        string `json:"scopeId"`
	ResourceKind   string `json:"resourceKind"`
	Transition     string `json:"transition"`
	Committed      bool   `json:"committed"`
}

const restScopeIDAnnotation = "cluster.t4.dev/scope-id"

var canonicalScopeIDPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$`)

func runtimeControlLedgerName(hostRef string) string {
	digest := sha256.Sum256([]byte("admission:" + hostRef))
	return "t4-control-" + hex.EncodeToString(digest[:])[:24]
}

func initialControlLedgerState() map[string]json.RawMessage {
	state := map[string]json.RawMessage{}
	state["version"] = json.RawMessage("1")
	for _, field := range []string{"eventHeads", "tickets", "idempotency", "tombstones", "issuedIdentifiers", "events", "admissionReservations", "admissionRateEvents", "admissionRetirements", "runtimeIngress"} {
		state[field] = json.RawMessage("[]")
	}
	return state
}

func decodeRuntimeIngress(data string) (map[string]json.RawMessage, []runtimeIngressRecord, error) {
	state := initialControlLedgerState()
	if data != "" {
		if err := json.Unmarshal([]byte(data), &state); err != nil {
			return nil, nil, err
		}
	}
	var records []runtimeIngressRecord
	if raw, ok := state["runtimeIngress"]; ok {
		if err := json.Unmarshal(raw, &records); err != nil {
			return nil, nil, err
		}
	}
	return state, records, nil
}

func encodeRuntimeIngress(state map[string]json.RawMessage, records []runtimeIngressRecord) (string, error) {
	raw, err := json.Marshal(records)
	if err != nil {
		return "", err
	}
	state["runtimeIngress"] = raw
	encoded, err := json.Marshal(state)
	if err != nil || len(encoded) > 768*1024 {
		if err == nil {
			err = errors.New("runtime ingress ledger exceeds its size bound")
		}
		return "", err
	}
	return string(encoded), nil
}

func findRuntimeIngress(records []runtimeIngressRecord, runtimeID, generation string) int {
	for index := range records {
		if records[index].RuntimeID == runtimeID && records[index].Generation == generation {
			return index
		}
	}
	return -1
}

func liveRuntimeIngressLeases(leases []runtimeIngressLease, now int64) []runtimeIngressLease {
	live := make([]runtimeIngressLease, 0, len(leases))
	for _, lease := range leases {
		if lease.ExpiresAt > now && lease.LeaseIDDigest != "" && lease.GatewayReplicaEpoch != "" {
			live = append(live, lease)
		}
	}
	return live
}

func readRuntimeIngress(ctx context.Context, reader client.Reader, namespace, hostRef, runtimeID, generation string) (runtimeIngressState, error) {
	var configMap corev1.ConfigMap
	err := reader.Get(ctx, types.NamespacedName{Namespace: namespace, Name: runtimeControlLedgerName(hostRef)}, &configMap)
	if apierrors.IsNotFound(err) {
		return runtimeIngressState{Open: true}, nil
	}
	if err != nil {
		return runtimeIngressState{}, err
	}
	_, records, err := decodeRuntimeIngress(configMap.Data["state"])
	if err != nil {
		return runtimeIngressState{}, err
	}
	index := findRuntimeIngress(records, runtimeID, generation)
	if index < 0 {
		return runtimeIngressState{Open: true}, nil
	}
	leases := liveRuntimeIngressLeases(records[index].Leases, time.Now().UnixMilli())
	return runtimeIngressState{Open: records[index].Open, Reopening: records[index].Reopening, ActiveLeases: len(leases), leases: leases}, nil
}

func mutateRuntimeIngress(ctx context.Context, store client.Client, namespace, hostRef, runtimeID, generation string, mutation func(runtimeIngressState) (runtimeIngressState, bool, error)) (runtimeIngressState, error) {
	name := runtimeControlLedgerName(hostRef)
	for attempt := 0; attempt < 8; attempt++ {
		var configMap corev1.ConfigMap
		err := store.Get(ctx, types.NamespacedName{Namespace: namespace, Name: name}, &configMap)
		missing := apierrors.IsNotFound(err)
		if err != nil && !missing {
			return runtimeIngressState{}, err
		}
		state, records, err := decodeRuntimeIngress(configMap.Data["state"])
		if err != nil {
			return runtimeIngressState{}, err
		}
		index := findRuntimeIngress(records, runtimeID, generation)
		current := runtimeIngressState{Open: true}
		if index >= 0 {
			leases := liveRuntimeIngressLeases(records[index].Leases, time.Now().UnixMilli())
			current = runtimeIngressState{Open: records[index].Open, Reopening: records[index].Reopening, ActiveLeases: len(leases), leases: leases}
		}
		next, changed, err := mutation(current)
		if err != nil || !changed {
			return next, err
		}
		if index < 0 {
			records = append(records, runtimeIngressRecord{RuntimeID: runtimeID, Generation: generation, Open: next.Open, Reopening: next.Reopening, Leases: current.leases})
		} else {
			records[index].Open = next.Open
			records[index].Reopening = next.Reopening
			records[index].Leases = current.leases
		}
		compacted := records[:0]
		for _, record := range records {
			live := liveRuntimeIngressLeases(record.Leases, time.Now().UnixMilli())
			if record.RuntimeID == runtimeID && record.Generation != generation && !record.Open && len(live) == 0 {
				continue
			}
			record.Leases = live
			compacted = append(compacted, record)
		}
		records = compacted
		encoded, err := encodeRuntimeIngress(state, records)
		if err != nil {
			return runtimeIngressState{}, err
		}
		if missing {
			configMap = corev1.ConfigMap{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: namespace, Labels: map[string]string{"app.kubernetes.io/managed-by": "omperator", "cluster.t4.dev/control-ledger": "true"}}, Data: map[string]string{"state": encoded}}
			err = store.Create(ctx, &configMap)
		} else {
			if configMap.Data == nil {
				configMap.Data = map[string]string{}
			}
			configMap.Data["state"] = encoded
			err = store.Update(ctx, &configMap)
		}
		if apierrors.IsConflict(err) || apierrors.IsAlreadyExists(err) {
			continue
		}
		if err != nil {
			return runtimeIngressState{}, err
		}
		return next, nil
	}
	return runtimeIngressState{}, fmt.Errorf("runtime ingress ledger remained contended")
}

func retireRuntimeActivationAdmission(ctx context.Context, store client.Client, namespace, hostRef, runtimeID, scopeID string) error {
	if runtimeID == "" {
		return nil
	}
	if !canonicalScopeIDPattern.MatchString(scopeID) {
		return errors.New("runtime canonical scope binding is missing or invalid")
	}
	name := runtimeControlLedgerName(hostRef)
	for range 8 {
		var configMap corev1.ConfigMap
		if err := store.Get(ctx, types.NamespacedName{Namespace: namespace, Name: name}, &configMap); err != nil {
			if apierrors.IsNotFound(err) {
				return nil
			}
			return err
		}
		state, _, err := decodeRuntimeIngress(configMap.Data["state"])
		if err != nil {
			return err
		}
		var reservations []json.RawMessage
		if raw := state["admissionReservations"]; raw != nil {
			if err := json.Unmarshal(raw, &reservations); err != nil {
				return err
			}
		}
		digest := sha256.Sum256([]byte(scopeID + "\x00runtime\x00" + runtimeID + "\x00activate"))
		resourceDigest := hex.EncodeToString(digest[:])
		retained := reservations[:0]
		released := false
		for _, raw := range reservations {
			var reservation admissionReservationRecord
			if err := json.Unmarshal(raw, &reservation); err != nil {
				return err
			}
			if reservation.Committed && reservation.ResourceDigest == resourceDigest {
				released = true
				continue
			}
			retained = append(retained, raw)
		}
		if !released {
			return nil
		}
		raw, err := json.Marshal(retained)
		if err != nil {
			return err
		}
		state["admissionReservations"] = raw
		encoded, err := json.Marshal(state)
		if err != nil || len(encoded) > 768*1024 {
			if err == nil {
				err = errors.New("control ledger exceeds its size bound")
			}
			return err
		}
		configMap.Data["state"] = string(encoded)
		if err := store.Update(ctx, &configMap); apierrors.IsConflict(err) {
			continue
		} else if err != nil {
			return err
		}
		return nil
	}
	return fmt.Errorf("admission retirement remained contended")
}
