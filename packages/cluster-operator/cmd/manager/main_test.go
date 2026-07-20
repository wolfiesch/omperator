package main

import (
	"testing"
	"time"

	"github.com/LycaonLLC/t4-code/packages/cluster-operator/controllers"
)

func TestManagerUsesLeaseLeaderElection(t *testing.T) {
	options := managerOptions()
	if !options.LeaderElection {
		t.Fatal("controller manager must enable leader election")
	}
	if options.LeaderElectionResourceLock != "leases" {
		t.Fatalf("leader-election resource lock = %q, want leases", options.LeaderElectionResourceLock)
	}
	if options.LeaderElectionID != "t4-cluster-operator.cluster.t4.dev" {
		t.Fatalf("leader-election ID = %q", options.LeaderElectionID)
	}
	if options.LeaseDuration == nil || options.RenewDeadline == nil || options.RetryPeriod == nil {
		t.Fatal("leader election timing must be explicit")
	}
	if *options.LeaseDuration < 15*time.Second || *options.RenewDeadline >= *options.LeaseDuration || *options.RetryPeriod >= *options.RenewDeadline {
		t.Fatalf("unsafe leader-election timing: lease=%v renew=%v retry=%v", *options.LeaseDuration, *options.RenewDeadline, *options.RetryPeriod)
	}
}

func TestManagerConfiguresDedicatedSessionAndServerServiceAccounts(t *testing.T) {
	t.Setenv("T4_SESSION_SERVICE_ACCOUNT", "release-session")
	t.Setenv("T4_CLUSTER_SERVER_SERVICE_ACCOUNT", "release-server")
	session, server := sessionServiceAccountNames()
	if session != "release-session" || server != "release-server" {
		t.Fatalf("ServiceAccounts = %q/%q", session, server)
	}
	t.Setenv("T4_SESSION_SERVICE_ACCOUNT", "")
	t.Setenv("T4_CLUSTER_SERVER_SERVICE_ACCOUNT", "")
	session, server = sessionServiceAccountNames()
	if session != controllers.DefaultSessionServiceAccount || server != controllers.DefaultServerServiceAccount {
		t.Fatalf("default ServiceAccounts = %q/%q", session, server)
	}
}

func TestManagerReadsSessionOMPReferencesWithoutSecretValues(t *testing.T) {
	t.Setenv("T4_SESSION_OMP_CONFIG_MAP", "omp-runtime-config")
	t.Setenv("T4_SESSION_OMP_MODELS_KEY", "provider-models")
	t.Setenv("T4_SESSION_OMP_SETTINGS_KEY", "agent-settings")
	t.Setenv("T4_SESSION_OMP_CREDENTIAL_SECRET", "omp-runtime-credential")
	t.Setenv("T4_SESSION_OMP_CREDENTIAL_KEY", "MODEL_API_KEY")
	t.Setenv("T4_SESSION_OMP_ALLOW_UNAUTHENTICATED", "false")

	got := sessionOMPConfigFromEnv()
	want := controllers.SessionOMPConfig{
		ConfigMapName:        "omp-runtime-config",
		ModelsKey:            "provider-models",
		SettingsKey:          "agent-settings",
		CredentialSecretName: "omp-runtime-credential",
		CredentialKey:        "MODEL_API_KEY",
	}
	if got != want {
		t.Fatalf("session OMP references = %#v, want %#v", got, want)
	}

	t.Setenv("T4_SESSION_OMP_CREDENTIAL_SECRET", "")
	t.Setenv("T4_SESSION_OMP_CREDENTIAL_KEY", "")
	t.Setenv("T4_SESSION_OMP_ALLOW_UNAUTHENTICATED", "true")
	got = sessionOMPConfigFromEnv()
	want.CredentialSecretName = ""
	want.CredentialKey = ""
	want.AllowUnauthenticated = true
	if got != want {
		t.Fatalf("unauthenticated session OMP references = %#v, want %#v", got, want)
	}
}
