use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[rustfmt::skip]
#[allow(dead_code)]
#[path = "../../../vendor/cmux-machine-provider-v1/upstream/cmux-tui/crates/cmux-tui-machine-protocol/src/lib.rs"]
mod machine_protocol;

use machine_protocol::*;
use serde::Serialize;

const FIXTURE_ROOT: &str = "vendor/cmux-machine-provider-v1/fixtures";
const PROVIDER_TOKEN: &str = "fixture-provider-generation-token";
const STREAM_TICKET: &str = "fixture-single-use-stream-ticket";
const WORKSPACE_AUTHORITY: &str = "fixture-workspace-authority-000000000001";

fn id(value: &str) -> OpaqueId {
    OpaqueId::new(value).expect("fixture opaque id is valid")
}

fn token(value: &str) -> BearerToken {
    BearerToken::new(value).expect("fixture bearer is valid")
}

fn encode_line<T: Serialize>(value: &T) -> Result<Vec<u8>, serde_json::Error> {
    let mut bytes = serde_json::to_vec(value)?;
    bytes.push(b'\n');
    Ok(bytes)
}

fn snapshot() -> SnapshotResult {
    SnapshotResult {
        revision: 17,
        scopes: vec![ScopeDescriptor {
            id: id("scope_personal"),
            display_name: "Personal".into(),
            kind: ScopeKind::Personal,
            can_admin: true,
        }],
        selected_scope_id: id("scope_personal"),
        machines: vec![MachineDescriptor {
            id: id("runtime_01"),
            display_name: "api-refactor".into(),
            subtitle: "Ready".into(),
            status: MachineStatus::Running,
            connectable: true,
            workspace_create: WorkspaceCreatePolicy::Provider {
                default_mode: WorkspaceCreateMode::Isolated,
                modes: vec![WorkspaceCreateMode::Isolated, WorkspaceCreateMode::Host],
            },
        }],
        selected_machine_id: Some(id("runtime_01")),
        capabilities: ProviderCapabilities {
            create_machine: true,
            connect_external_machine: true,
        },
        actions: vec![ProviderAction {
            id: id("runtime.rename"),
            label: "Rename runtime".into(),
            target: ProviderActionTarget::SelectedMachine,
            destructive: false,
            fields: vec![ActionField {
                id: "display_name".into(),
                kind: ActionFieldKind::Text,
                label: "Name".into(),
                required: true,
                max_length: Some(128),
                minimum: None,
                maximum: None,
                placeholder: Some("api-refactor".into()),
            }],
        }],
        notice: None,
    }
}

fn corpus() -> Result<BTreeMap<&'static str, Vec<u8>>, Box<dyn Error>> {
    let capabilities = vec![
        MACHINE_LIFECYCLE_CAPABILITY.to_owned(),
        WORKSPACE_LIFECYCLE_CAPABILITY.to_owned(),
        WORKSPACE_MIRROR_AUTHORITY_CAPABILITY.to_owned(),
        DURABLE_NOTICES_CAPABILITY.to_owned(),
        EXTERNAL_MACHINE_CONNECT_CAPABILITY.to_owned(),
        CLIENT_CAPABILITY_NEGOTIATION_CAPABILITY.to_owned(),
    ];
    let mut files = BTreeMap::new();
    files.insert(
        "control/hello.request.ndjson",
        encode_line(&RequestEnvelope::new(
            id("request-hello"),
            ProviderRequest::Hello(HelloParams {
                token: token(PROVIDER_TOKEN),
                client: ClientDescriptor {
                    name: "cmux-tui".into(),
                    version: "fixture".into(),
                    supported_versions: vec![1],
                },
            }),
        ))?,
    );
    files.insert(
        "control/hello.success.ndjson",
        encode_line(
            &ResponseEnvelope::success(
                id("request-hello"),
                HelloResult {
                    provider_id: id("omperator"),
                    provider_name: "Omperator".into(),
                    negotiated_version: Version,
                },
            )
            .with_capabilities(capabilities.clone()),
        )?,
    );
    files.insert(
        "control/negotiate-client-capabilities.request.ndjson",
        encode_line(&RequestEnvelope::new(
            id("request-negotiate"),
            ProviderRequest::NegotiateClientCapabilities(NegotiateClientCapabilitiesParams {
                capabilities: vec![PROVIDER_ACTION_TARGETS_CLIENT_CAPABILITY.to_owned()],
            }),
        ))?,
    );
    files.insert(
        "control/negotiate-client-capabilities.success.ndjson",
        encode_line(&ResponseEnvelope::success(
            id("request-negotiate"),
            NegotiateClientCapabilitiesResult {
                capabilities: vec![PROVIDER_ACTION_TARGETS_CLIENT_CAPABILITY.to_owned()],
            },
        ))?,
    );
    files.insert(
        "control/snapshot.request.ndjson",
        encode_line(&RequestEnvelope::new(
            id("request-snapshot"),
            ProviderRequest::Snapshot(SnapshotParams {
                known_revision: Some(16),
            }),
        ))?,
    );
    files.insert(
        "control/snapshot.success.ndjson",
        encode_line(&ResponseEnvelope::success(
            id("request-snapshot"),
            snapshot(),
        ))?,
    );
    files.insert(
        "control/open-machine.request.ndjson",
        encode_line(&RequestEnvelope::new(
            id("request-open"),
            ProviderRequest::OpenMachine(OpenMachineParams {
                machine_id: id("runtime_01"),
                workspace_mirror_authority: true,
            }),
        ))?,
    );
    files.insert(
        "control/open-machine.success.ndjson",
        encode_line(&ResponseEnvelope::success(
            id("request-open"),
            OpenMachineResult {
                connection_id: id("connection_01"),
                transport: TransportDescriptor::ProviderStream {
                    ticket: token(STREAM_TICKET),
                    expires_at: "2026-07-28T12:01:00Z".into(),
                },
                workspace_mirror_authority: Some(token(WORKSPACE_AUTHORITY)),
            },
        ))?,
    );
    files.insert(
        "control/durable-notice.event.ndjson",
        encode_line(&EventEnvelope::with_delivery(
            ProviderEvent::Notice(ProviderNotice {
                level: NoticeLevel::Warning,
                message: "Runtime will sleep after the idle deadline".into(),
            }),
            NoticeDelivery {
                notice_id: id("notice_01"),
                sequence: 4,
            },
        ))?,
    );
    files.insert(
        "control/failure.response.ndjson",
        encode_line(&ResponseEnvelope::<HelloResult>::failure(
            id("request-failed"),
            ProviderError {
                code: ProviderErrorCode::PermissionDenied,
                message: "scope access denied".into(),
                retryable: false,
            },
        ))?,
    );
    files.insert(
        "control/close-machine.request.ndjson",
        encode_line(&RequestEnvelope::new(
            id("request-close"),
            ProviderRequest::CloseMachine(CloseMachineParams {
                connection_id: id("connection_01"),
            }),
        ))?,
    );
    files.insert(
        "control/close-machine.success.ndjson",
        encode_line(&ResponseEnvelope::success(
            id("request-close"),
            CloseMachineResult { revision: 18 },
        ))?,
    );
    files.insert(
        "stream/transport-handshake.ndjson",
        encode_line(&TransportHandshake {
            protocol: Protocol,
            version: Version,
            role: TransportRole::Transport,
            token: token(PROVIDER_TOKEN),
            ticket: token(STREAM_TICKET),
        })?,
    );
    files.insert(
        "stream/transport-handshake-accepted.ndjson",
        encode_line(&TransportHandshakeResult { accepted: true })?,
    );
    Ok(files)
}

fn fixture_root(repo_root: &Path) -> PathBuf {
    repo_root.join(FIXTURE_ROOT)
}

fn repo_root() -> Result<PathBuf, Box<dyn Error>> {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    Ok(manifest_dir
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| io::Error::other("fixture harness must remain under scripts/"))?
        .to_path_buf())
}

fn actual_fixture_paths(root: &Path) -> Result<BTreeSet<String>, Box<dyn Error>> {
    let mut paths = BTreeSet::new();
    for directory in ["control", "stream"] {
        let directory_path = root.join(directory);
        if !directory_path.exists() {
            continue;
        }
        for entry in fs::read_dir(directory_path)? {
            let entry = entry?;
            if !entry.file_type()?.is_file() {
                return Err(io::Error::other(format!(
                    "unexpected non-file fixture {}",
                    entry.path().display()
                ))
                .into());
            }
            paths.insert(format!(
                "{directory}/{}",
                entry.file_name().to_string_lossy()
            ));
        }
    }
    Ok(paths)
}

fn generate(repo_root: &Path) -> Result<(), Box<dyn Error>> {
    let root = fixture_root(repo_root);
    let files = corpus()?;
    let expected = files
        .keys()
        .map(|path| (*path).to_owned())
        .collect::<BTreeSet<_>>();
    let actual = actual_fixture_paths(&root)?;
    if !actual.is_subset(&expected) {
        return Err(io::Error::other(format!(
            "refusing to replace unexpected fixture paths: {:?}",
            actual.difference(&expected).collect::<Vec<_>>()
        ))
        .into());
    }
    for (relative, bytes) in files {
        let path = root.join(relative);
        fs::create_dir_all(path.parent().expect("fixture has parent"))?;
        fs::write(path, bytes)?;
    }
    Ok(())
}

fn check(repo_root: &Path) -> Result<(), Box<dyn Error>> {
    let root = fixture_root(repo_root);
    let files = corpus()?;
    let expected = files
        .keys()
        .map(|path| (*path).to_owned())
        .collect::<BTreeSet<_>>();
    let actual = actual_fixture_paths(&root)?;
    if actual != expected {
        return Err(io::Error::other(format!(
            "fixture membership differs: expected {expected:?}, found {actual:?}"
        ))
        .into());
    }
    for (relative, wanted) in &files {
        let actual_bytes = fs::read(root.join(relative))?;
        if &actual_bytes != wanted {
            return Err(io::Error::other(format!("fixture differs: {relative}")).into());
        }
        let _: serde_json::Value = serde_json::from_slice(&actual_bytes)?;
    }
    let open: serde_json::Value = serde_json::from_slice(
        files
            .get("control/open-machine.success.ndjson")
            .expect("open fixture exists"),
    )?;
    let handshake: serde_json::Value = serde_json::from_slice(
        files
            .get("stream/transport-handshake.ndjson")
            .expect("handshake fixture exists"),
    )?;
    if open["result"]["transport"]["ticket"] != handshake["ticket"] {
        return Err(io::Error::other("open-machine ticket does not match stream handshake").into());
    }
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    let root = repo_root()?;
    match std::env::args().nth(1).as_deref() {
        Some("generate") => generate(&root),
        Some("check") => check(&root),
        _ => Err(io::Error::other("usage: cmux-machine-protocol-fixtures <generate|check>").into()),
    }
}
