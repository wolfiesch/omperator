package main

import (
	"flag"
	"os"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	storagev1 "k8s.io/api/storage/v1"
	apiresource "k8s.io/apimachinery/pkg/api/resource"
	"k8s.io/apimachinery/pkg/runtime"
	utilruntime "k8s.io/apimachinery/pkg/util/runtime"
	clientgoscheme "k8s.io/client-go/kubernetes/scheme"
	ctrl "sigs.k8s.io/controller-runtime"
	"sigs.k8s.io/controller-runtime/pkg/cache"
	"sigs.k8s.io/controller-runtime/pkg/healthz"
	"sigs.k8s.io/controller-runtime/pkg/log/zap"
	metricsserver "sigs.k8s.io/controller-runtime/pkg/metrics/server"

	clusterv1alpha1 "github.com/LycaonLLC/t4-code/packages/cluster-operator/api/v1alpha1"
	"github.com/LycaonLLC/t4-code/packages/cluster-operator/controllers"
)

var scheme = runtime.NewScheme()

func init() {
	utilruntime.Must(clientgoscheme.AddToScheme(scheme))
	utilruntime.Must(corev1.AddToScheme(scheme))
	utilruntime.Must(storagev1.AddToScheme(scheme))
	utilruntime.Must(clusterv1alpha1.AddToScheme(scheme))
}

func managerOptions() ctrl.Options {
	leaseDuration := 30 * time.Second
	renewDeadline := 20 * time.Second
	retryPeriod := 5 * time.Second
	options := ctrl.Options{
		Scheme:                        scheme,
		Metrics:                       metricsserver.Options{BindAddress: ":8080"},
		HealthProbeBindAddress:        ":8081",
		LeaderElection:                true,
		LeaderElectionResourceLock:    "leases",
		LeaderElectionID:              "t4-cluster-operator.cluster.t4.dev",
		LeaderElectionReleaseOnCancel: true,
		LeaseDuration:                 &leaseDuration,
		RenewDeadline:                 &renewDeadline,
		RetryPeriod:                   &retryPeriod,
	}
	if namespace := strings.TrimSpace(os.Getenv("POD_NAMESPACE")); namespace != "" {
		options.Cache = cache.Options{DefaultNamespaces: map[string]cache.Config{namespace: {}}}
	}
	return options
}

func main() {
	var development bool
	flag.BoolVar(&development, "development", false, "enable development logging")
	zapOptions := zap.Options{Development: development}
	zapOptions.BindFlags(flag.CommandLine)
	flag.Parse()
	ctrl.SetLogger(zap.New(zap.UseFlagOptions(&zapOptions)))

	manager, err := ctrl.NewManager(ctrl.GetConfigOrDie(), managerOptions())
	if err != nil {
		ctrl.Log.Error(err, "unable to create controller manager")
		os.Exit(1)
	}
	if err := (&controllers.ClusterHostReconciler{Client: manager.GetClient(), Scheme: manager.GetScheme()}).SetupWithManager(manager); err != nil {
		ctrl.Log.Error(err, "unable to register T4ClusterHost controller")
		os.Exit(1)
	}
	if err := (&controllers.WorkspaceReconciler{Client: manager.GetClient(), Scheme: manager.GetScheme()}).SetupWithManager(manager); err != nil {
		ctrl.Log.Error(err, "unable to register T4Workspace controller")
		os.Exit(1)
	}
	excludedNodes := splitNonempty(os.Getenv("T4_SESSION_EXCLUDED_NODES"))
	sessionServiceAccount, serverServiceAccount := sessionServiceAccountNames()
	if err := (&controllers.SessionReconciler{
		Client: manager.GetClient(), APIReader: manager.GetAPIReader(), Scheme: manager.GetScheme(),
		RuntimeImage:              os.Getenv("T4_SESSION_RUNTIME_IMAGE"),
		SessionServiceAccountName: sessionServiceAccount,
		ServerServiceAccountName:  serverServiceAccount,
		KubernetesAPIAudience:     envOr("T4_KUBERNETES_API_AUDIENCE", controllers.DefaultKubernetesAPIAudience),
		OMPConfig:                 sessionOMPConfigFromEnv(),
		ExcludedNodeNames:         excludedNodes,
		Resources: corev1.ResourceRequirements{
			Requests: corev1.ResourceList{
				corev1.ResourceCPU:    apiresource.MustParse(envOr("T4_SESSION_REQUEST_CPU", "500m")),
				corev1.ResourceMemory: apiresource.MustParse(envOr("T4_SESSION_REQUEST_MEMORY", "1Gi")),
			},
			Limits: corev1.ResourceList{
				corev1.ResourceCPU:    apiresource.MustParse(envOr("T4_SESSION_LIMIT_CPU", "4")),
				corev1.ResourceMemory: apiresource.MustParse(envOr("T4_SESSION_LIMIT_MEMORY", "8Gi")),
			},
		},
		SharedMemorySize: apiresource.MustParse(envOr("T4_SESSION_SHM_SIZE", "1Gi")),
		TemporarySize:    apiresource.MustParse(envOr("T4_SESSION_TEMPORARY_SIZE", "2Gi")),
	}).SetupWithManager(manager); err != nil {
		ctrl.Log.Error(err, "unable to register T4Session controller")
		os.Exit(1)
	}
	if err := manager.AddHealthzCheck("healthz", healthz.Ping); err != nil {
		ctrl.Log.Error(err, "unable to install health check")
		os.Exit(1)
	}
	if err := manager.AddReadyzCheck("readyz", healthz.Ping); err != nil {
		ctrl.Log.Error(err, "unable to install readiness check")
		os.Exit(1)
	}
	if err := manager.Start(ctrl.SetupSignalHandler()); err != nil {
		ctrl.Log.Error(err, "controller manager stopped")
		os.Exit(1)
	}
}

func splitNonempty(value string) []string {
	var result []string
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			result = append(result, item)
		}
	}
	return result
}

func sessionOMPConfigFromEnv() controllers.SessionOMPConfig {
	return controllers.SessionOMPConfig{
		ConfigMapName:        os.Getenv("T4_SESSION_OMP_CONFIG_MAP"),
		ModelsKey:            os.Getenv("T4_SESSION_OMP_MODELS_KEY"),
		SettingsKey:          os.Getenv("T4_SESSION_OMP_SETTINGS_KEY"),
		CredentialSecretName: os.Getenv("T4_SESSION_OMP_CREDENTIAL_SECRET"),
		CredentialKey:        os.Getenv("T4_SESSION_OMP_CREDENTIAL_KEY"),
		AllowUnauthenticated: strings.EqualFold(strings.TrimSpace(os.Getenv("T4_SESSION_OMP_ALLOW_UNAUTHENTICATED")), "true"),
	}
}

func sessionServiceAccountNames() (string, string) {
	return envOr("T4_SESSION_SERVICE_ACCOUNT", controllers.DefaultSessionServiceAccount),
		envOr("T4_CLUSTER_SERVER_SERVICE_ACCOUNT", controllers.DefaultServerServiceAccount)
}

func envOr(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}
