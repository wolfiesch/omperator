package controllers

import (
	"sync"

	"github.com/prometheus/client_golang/prometheus"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/types"
	controllermetrics "sigs.k8s.io/controller-runtime/pkg/metrics"
)

const (
	metricKindClusterHost = "clusterhost"
	metricKindWorkspace   = "workspace"
	metricKindSession     = "session"
)

var (
	reconcileTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name: "t4_cluster_reconcile_total",
			Help: "Total completed T4 cluster reconciliations by resource kind and result.",
		},
		[]string{"kind", "result"},
	)
	conditionGauge = prometheus.NewGaugeVec(
		prometheus.GaugeOpts{
			Name: "t4_cluster_condition",
			Help: "Number of currently observed T4 cluster resources by kind, condition, and boolean status.",
		},
		[]string{"kind", "condition", "status"},
	)
	registerControllerMetricsOnce sync.Once
	conditionStore                = aggregateConditionStore{
		resources: make(map[string]map[types.NamespacedName]map[string]metav1.ConditionStatus),
	}
)

var knownConditions = map[string][]string{
	metricKindClusterHost: {"Available", "CIReady", "StorageReady"},
	metricKindWorkspace:   {"HostReady", "Ready", "StorageReady"},
	metricKindSession:     {"Available", "HostReady", "RuntimeConfigured", "WorkspaceReady"},
}

type aggregateConditionStore struct {
	mu        sync.Mutex
	resources map[string]map[types.NamespacedName]map[string]metav1.ConditionStatus
}

func init() {
	registerControllerMetrics()
}

func registerControllerMetrics() {
	registerControllerMetricsOnce.Do(func() {
		controllermetrics.Registry.MustRegister(reconcileTotal, conditionGauge)
		for kind, conditions := range knownConditions {
			reconcileTotal.WithLabelValues(kind, "success")
			reconcileTotal.WithLabelValues(kind, "error")
			for _, conditionType := range conditions {
				conditionGauge.WithLabelValues(kind, conditionType, "true").Set(0)
				conditionGauge.WithLabelValues(kind, conditionType, "false").Set(0)
			}
		}
	})
}

func observeReconcile(kind string, key types.NamespacedName, conditions []metav1.Condition, objectPresent bool, reconcileErr error) {
	result := "success"
	if reconcileErr != nil {
		result = "error"
	}
	reconcileTotal.WithLabelValues(kind, result).Inc()

	if !objectPresent && reconcileErr != nil {
		return
	}
	conditionStore.project(kind, key, conditions, objectPresent)
}

func conditionObjectPresent(object metav1.Object, fetched bool, reconcileErr error) bool {
	if !fetched {
		return false
	}
	return reconcileErr != nil || object.GetDeletionTimestamp().IsZero() || len(object.GetFinalizers()) > 0
}

func (s *aggregateConditionStore) project(kind string, key types.NamespacedName, conditions []metav1.Condition, objectPresent bool) {
	s.mu.Lock()
	defer s.mu.Unlock()

	resources := s.resources[kind]
	if resources == nil {
		resources = make(map[types.NamespacedName]map[string]metav1.ConditionStatus)
		s.resources[kind] = resources
	}
	if objectPresent {
		current := resources[key]
		if current == nil {
			current = make(map[string]metav1.ConditionStatus, len(knownConditions[kind]))
		} else {
			clear(current)
		}
		for i := range conditions {
			if containsCondition(knownConditions[kind], conditions[i].Type) && (conditions[i].Status == metav1.ConditionTrue || conditions[i].Status == metav1.ConditionFalse) {
				current[conditions[i].Type] = conditions[i].Status
			}
		}
		resources[key] = current
	} else {
		delete(resources, key)
	}

	for _, conditionType := range knownConditions[kind] {
		var trueCount, falseCount int
		for _, current := range resources {
			switch current[conditionType] {
			case metav1.ConditionTrue:
				trueCount++
			case metav1.ConditionFalse:
				falseCount++
			}
		}
		conditionGauge.WithLabelValues(kind, conditionType, "true").Set(float64(trueCount))
		conditionGauge.WithLabelValues(kind, conditionType, "false").Set(float64(falseCount))
	}
}

func containsCondition(conditions []string, wanted string) bool {
	for _, condition := range conditions {
		if condition == wanted {
			return true
		}
	}
	return false
}
