package controllers

import (
	"context"
	"errors"
	"sync"
	"time"

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
	reconcileDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:        "omperator_reconcile_duration_seconds",
			Help:        "Controller reconciliation duration by bounded resource kind and result.",
			ConstLabels: prometheus.Labels{"component": "cluster-operator"},
			Buckets:     prometheus.DefBuckets,
		},
		[]string{"resource", "result"},
	)
	reconcileErrors = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name:        "omperator_reconcile_errors_total",
			Help:        "Controller reconciliation failures by bounded resource kind and error class.",
			ConstLabels: prometheus.Labels{"component": "cluster-operator"},
		},
		[]string{"resource", "error_class"},
	)
	runtimeStartDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:        "omperator_runtime_start_duration_seconds",
			Help:        "Runtime start duration by bounded result.",
			ConstLabels: prometheus.Labels{"component": "cluster-operator"},
			Buckets:     prometheus.DefBuckets,
		},
		[]string{"result"},
	)
	runtimeFenceDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:        "omperator_runtime_fence_duration_seconds",
			Help:        "Runtime positive-fence duration by bounded result.",
			ConstLabels: prometheus.Labels{"component": "cluster-operator"},
			Buckets:     prometheus.DefBuckets,
		},
		[]string{"result"},
	)
	storageOperationDuration = prometheus.NewHistogramVec(
		prometheus.HistogramOpts{
			Name:        "omperator_storage_operation_duration_seconds",
			Help:        "Storage operation duration by bounded operation and result.",
			ConstLabels: prometheus.Labels{"component": "cluster-operator"},
			Buckets:     prometheus.DefBuckets,
		},
		[]string{"operation", "result"},
	)
	runtimeReady = prometheus.NewGauge(prometheus.GaugeOpts{
		Name:        "omperator_runtime_ready",
		Help:        "Number of currently ready runtimes.",
		ConstLabels: prometheus.Labels{"component": "cluster-operator"},
	})
	drainTotal = prometheus.NewCounterVec(
		prometheus.CounterOpts{
			Name:        "omperator_drain_total",
			Help:        "Generation-bound runtime drain outcomes.",
			ConstLabels: prometheus.Labels{"component": "cluster-operator"},
		},
		[]string{"result"},
	)
	registerControllerMetricsOnce sync.Once
	runtimeReadyStore             = aggregateReadyStore{resources: make(map[types.NamespacedName]bool)}
)

type aggregateReadyStore struct {
	mu        sync.Mutex
	resources map[types.NamespacedName]bool
}

func init() { registerControllerMetrics() }

func registerControllerMetrics() {
	registerControllerMetricsOnce.Do(func() {
		controllermetrics.Registry.MustRegister(reconcileDuration, reconcileErrors, runtimeStartDuration, runtimeFenceDuration, storageOperationDuration, runtimeReady, drainTotal)
		for _, resource := range []string{metricKindClusterHost, metricKindWorkspace, metricKindSession} {
			for _, result := range []string{"success", "error"} {
				reconcileDuration.WithLabelValues(resource, result)
			}
			reconcileErrors.WithLabelValues(resource, "internal")
		}
		for _, result := range []string{"success", "error", "timeout", "fenced"} {
			runtimeStartDuration.WithLabelValues(result)
			runtimeFenceDuration.WithLabelValues(result)
			for _, operation := range []string{"read", "write", "remount", "probe"} {
				storageOperationDuration.WithLabelValues(operation, result)
			}
		}
		runtimeReady.Set(0)
		for _, result := range []string{"success", "error", "timeout"} {
			drainTotal.WithLabelValues(result)
		}
	})
}

func observeReconcile(kind string, key types.NamespacedName, phase string, objectPresent bool, reconcileErr error, startedAt time.Time) {
	result := "success"
	if reconcileErr != nil {
		result = "error"
		reconcileErrors.WithLabelValues(kind, "internal").Inc()
	}
	reconcileDuration.WithLabelValues(kind, result).Observe(time.Since(startedAt).Seconds())
	if kind == metricKindSession && (objectPresent || reconcileErr == nil) {
		runtimeReadyStore.project(key, phase == "Ready", objectPresent)
	}
}

func conditionObjectPresent(object metav1.Object, fetched bool, reconcileErr error) bool {
	if !fetched {
		return false
	}
	return reconcileErr != nil || object.GetDeletionTimestamp().IsZero() || len(object.GetFinalizers()) > 0
}

func observeDrain(err error) {
	result := "success"
	if errors.Is(err, context.DeadlineExceeded) {
		result = "timeout"
	} else if err != nil {
		result = "error"
	}
	drainTotal.WithLabelValues(result).Inc()
}

func durationResult(err error, failed, fenced bool) string {
	if errors.Is(err, context.DeadlineExceeded) {
		return "timeout"
	}
	if err != nil || failed {
		return "error"
	}
	if fenced {
		return "fenced"
	}
	return "success"
}

func observeRuntimeStart(err error, failed bool, startedAt time.Time) {
	runtimeStartDuration.WithLabelValues(durationResult(err, failed, false)).Observe(time.Since(startedAt).Seconds())
}

func observeRuntimeFence(err error, uncertain bool, startedAt time.Time) {
	runtimeFenceDuration.WithLabelValues(durationResult(err, false, uncertain)).Observe(time.Since(startedAt).Seconds())
}

func observeStorageOperation(operation string, err error, failed bool, startedAt time.Time) {
	storageOperationDuration.WithLabelValues(operation, durationResult(err, failed, false)).Observe(time.Since(startedAt).Seconds())
}

func (s *aggregateReadyStore) project(key types.NamespacedName, ready, objectPresent bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if objectPresent {
		s.resources[key] = ready
	} else {
		delete(s.resources, key)
	}
	count := 0
	for _, current := range s.resources {
		if current {
			count++
		}
	}
	runtimeReady.Set(float64(count))
}
