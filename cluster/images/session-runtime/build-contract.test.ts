import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dir, "../../..");
const readRepositoryFile = (relativePath: string): Promise<string> =>
	readFile(path.join(repositoryRoot, relativePath), "utf8");

describe("session runtime image build contract", () => {
	test("uses the portable-platform cmux pin as its single source authority", async () => {
		const [dockerfile, provenanceText, compatibilityText, notice, builder] = await Promise.all([
			readRepositoryFile("cluster/images/session-runtime/Dockerfile"),
			readRepositoryFile("provenance/cmux-runtime-v1.json"),
			readRepositoryFile("compat/portable-agent-platform-v1.json"),
			readRepositoryFile("licenses/CMUX-TUI-MIT-NOTICE.txt"),
			readRepositoryFile("scripts/build-pinned-cmux.mjs"),
		]);
		const provenance = JSON.parse(provenanceText) as {
			source: { repository: string; commit: string; rootGitTree: string; cmuxTuiGitTree: string; cargoLockGitBlob: string; ghosttyCommit: string };
			build: { rustToolchain: string; zigToolchain: string; locked: boolean };
		};
		const compatibility = JSON.parse(compatibilityText) as {
			baselines: { cmux: { repository: string; commit: string } };
		};

		expect(provenance.source.repository).toBe(compatibility.baselines.cmux.repository);
		expect(provenance.source.commit).toBe(compatibility.baselines.cmux.commit);
		expect(provenance.build.locked).toBe(true);
		expect(notice).toContain("Declared license: MIT");
		expect(notice).toContain(`Pinned commit: ${provenance.source.commit}`);
		expect(dockerfile).toContain("COPY provenance/cmux-runtime-v1.json /opt/provenance/cmux-runtime-v1.json");
		expect(dockerfile).toContain('require("/opt/provenance/cmux-runtime-v1.json").source.commit');
		expect(dockerfile).not.toContain(provenance.source.commit);
		expect(builder).toContain('provenance.source.rootGitTree, "source tree"');
		expect(builder).toContain('provenance.source.cmuxTuiGitTree, "cmux-tui tree"');
		expect(builder).toContain('provenance.source.cargoLockGitBlob');
		expect(builder).toContain('provenance.source.ghosttyCommit, "ghostty commit"');
		expect(builder).toContain('fail("source checkout is dirty; refusing a non-reproducible build")');
		expect(builder).toContain("binarySha256");
	});

	test("pins the admitted OMP authority source and embeds immutable provenance", async () => {
		const [dockerfile, provenanceText, compatibilityText, matrixText] = await Promise.all([
			readRepositoryFile("cluster/images/session-runtime/Dockerfile"),
			readRepositoryFile("provenance/omp-runtime-v1.json"),
			readRepositoryFile("compat/portable-agent-platform-v1.json"),
			readRepositoryFile("compat/omp-app-matrix.json"),
		]);
		const provenance = JSON.parse(provenanceText) as {
			source: { repository: string; commit: string; contractCommit: string; contractAncestry: string };
			bridge: { protocol: string; methods: string[]; compatibilityStatus: string };
			rollout: { components: string[]; independentComponentRollsAllowed: boolean };
		};
		const compatibility = JSON.parse(compatibilityText) as {
			ompPinResolution: { repository: string; sourceCommit: string; contractCommit: string; portableRuntimeAdmission: string };
			compatibilitySetPolicy: { rollTogether: string[]; independentComponentRollsAllowed: boolean };
		};
		const matrix = JSON.parse(matrixText) as {
			portableRuntime: { sourceRepository: string; sourceCommit: string; contractCommit: string; bridge: { protocol: string; methods: string[]; compatibilityStatus: string } };
		};

		expect(provenance.source.repository).toBe(compatibility.ompPinResolution.repository);
		expect(provenance.source.commit).toBe(compatibility.ompPinResolution.sourceCommit);
		expect(provenance.source.contractCommit).toBe(compatibility.ompPinResolution.contractCommit);
		expect(provenance.source.contractAncestry).toBe("descendant");
		expect(provenance.bridge.compatibilityStatus).toBe("admitted");
		expect(provenance.rollout.components).toEqual(compatibility.compatibilitySetPolicy.rollTogether);
		expect(provenance.rollout.independentComponentRollsAllowed).toBe(false);
		expect(matrix.portableRuntime.sourceRepository).toBe(provenance.source.repository);
		expect(matrix.portableRuntime.sourceCommit).toBe(provenance.source.commit);
		expect(matrix.portableRuntime.contractCommit).toBe(provenance.source.contractCommit);
		expect(matrix.portableRuntime.bridge).toEqual(provenance.bridge);
		expect(dockerfile).toContain("COPY provenance/omp-runtime-v1.json /opt/provenance/omp-runtime-v1.json");
		expect(dockerfile).toContain("build-essential ca-certificates cmake git libclang-dev pkg-config libssl-dev");
		expect(dockerfile).toContain('git fetch --depth=1 origin "${omp_commit}"');
		expect(dockerfile).toContain(`git rev-parse 'FETCH_HEAD^{commit}'`);
		expect(dockerfile).toContain('test "$(git rev-parse HEAD)" = "${omp_commit}"');
		expect(dockerfile).toContain("rm -rf .git target packages/natives/native/.build");
		expect(dockerfile).toContain("COPY --chmod=0644 provenance/omp-runtime-v1.json /usr/share/t4/provenance/omp-runtime-v1.json");
		expect(dockerfile).toContain(`T4_OMP_BUILD=${provenance.source.commit}`);
		expect(dockerfile).toContain(`io.t4.omp.revision="${provenance.source.commit}"`);
		expect(dockerfile).toContain(`io.t4.omp.contract-revision="${provenance.source.contractCommit}"`);
		expect(dockerfile).toContain('io.t4.omp.provenance="/usr/share/t4/provenance/omp-runtime-v1.json"');
	});

	test("cross-compiles and records one native artifact for each supported OCI architecture", async () => {
		const [dockerfile, builder] = await Promise.all([
			readRepositoryFile("cluster/images/session-runtime/Dockerfile"),
			readRepositoryFile("scripts/build-pinned-cmux.mjs"),
		]);
		expect(dockerfile.match(/^FROM --platform=\$BUILDPLATFORM /gmu)).toHaveLength(2);
		expect(dockerfile).toContain("AS cmux-node");
		expect(dockerfile).toContain("AS cmux-build");
		expect(dockerfile).toContain("ARG BUILDARCH");
		expect(dockerfile).toContain("ARG TARGETARCH");
		expect(dockerfile).toContain('case "${BUILDARCH}" in');
		expect(dockerfile).toContain("amd64) zig_arch=x86_64;");
		expect(dockerfile).toContain("rust_target=x86_64-unknown-linux-gnu");
		expect(dockerfile).toContain("arm64) zig_arch=aarch64;");
		expect(dockerfile).toContain("rust_target=aarch64-unknown-linux-gnu");
		expect(dockerfile).toContain("unsupported TARGETARCH=");
		expect(dockerfile).toContain("sha256sum --check --strict");
		expect(dockerfile).toContain("ca-certificates curl git libclang-dev xz-utils");
		expect(dockerfile).toContain("amd64) cross_linker_package=gcc-x86-64-linux-gnu; cross_libc_package=libc6-dev-amd64-cross");
		expect(dockerfile).toContain("arm64) cross_linker_package=gcc-aarch64-linux-gnu; cross_libc_package=libc6-dev-arm64-cross");
		expect(dockerfile).toContain('"${cross_linker_package}" "${cross_libc_package}"');
		expect(builder).toContain('["CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_LINKER", "x86_64-linux-gnu-gcc"]');
		expect(builder).toContain('["CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER", "aarch64-linux-gnu-gcc"]');
		expect(builder).toContain('loader: "/usr/x86_64-linux-gnu/lib/ld-linux-x86-64.so.2"');
		expect(builder).toContain('libraryPath: "/usr/x86_64-linux-gnu/lib"');
		expect(builder).toContain('loader: "/usr/aarch64-linux-gnu/lib/ld-linux-aarch64.so.1"');
		expect(builder).toContain('libraryPath: "/usr/aarch64-linux-gnu/lib"');
		expect(builder).toContain('["--library-path", targetRuntime.libraryPath, outputBinary, "--version"]');
		expect(builder).toContain(': command(outputBinary, ["--version"], { env: {} })');
		expect(dockerfile).toContain("SOURCE_DATE_EPOCH=0");
		expect(builder).toContain('"--locked"');
		expect(builder).toContain('CMUX_GHOSTTY_VT_ZIG_CPU: "baseline"');
		expect(builder).toContain('return typeof output === "string" ? output.trim() : "";');
		expect(builder).toContain('stdio: ["ignore", "pipe", "pipe"]');
		expect(builder).toContain('stdio: ["ignore", "inherit", "inherit"]');
		const finalStage = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
		expect(finalStage).toStartWith(
			"\nFROM docker.io/library/node:24.13.1-bookworm@sha256:00e9195ebd49985a6da8921f419978d85dfe354589755192dc090425ce4da2f7",
		);
		expect(finalStage).toContain(
			"COPY --from=docker.io/oven/bun:1.3.14-debian@sha256:9dba1a1b43ce28c9d7931bfc4eb00feb63b0114720a0277a8f939ae4dfc9db6f /usr/local/bin/bun /usr/local/bin/bun",
		);
		expect(dockerfile).toContain(`git rev-parse 'FETCH_HEAD^{commit}'`);
		expect(dockerfile).toContain("OMP_AUTHORITY_BRIDGE_PROTOCOL");
		expect(dockerfile).toContain("process.stdout.write(OMP_AUTHORITY_BRIDGE_PROTOCOL)");
		expect(finalStage).toContain("https://snapshot.debian.org/archive/debian/20250721T000000Z");
		expect(finalStage).toContain("https://snapshot.debian.org/archive/debian-security/20250721T000000Z");
		expect(finalStage).toContain("apt-get -o Acquire::Check-Valid-Until=false update");
		expect(finalStage).toContain("bash ca-certificates chromium");
		expect(finalStage).toContain("tini util-linux xvfb");
		expect(finalStage).toContain("HOME=/run/t4");
		expect(finalStage).toContain("chmod 0711 /run/t4");
		expect(finalStage).not.toContain("HOME=/workspace");
		expect(dockerfile).toContain("/usr/share/t4/provenance/cmux-tui.manifest.json");
		expect(dockerfile).not.toContain('mv "/out/cmux-tui-$(cat /tmp/rust-target)" /out/cmux-tui');
		expect(finalStage).toContain("COPY --from=cmux-build --chmod=0755 /out/cmux-tui-* /usr/local/lib/t4/cmux/");
		expect(finalStage).toContain('ln -s "/usr/local/lib/t4/cmux/cmux-tui-${cmux_target}" /usr/local/bin/cmux-tui');
		expect(finalStage).toContain("chmod 0755 /usr/share/t4 /usr/share/t4/provenance /usr/share/licenses /usr/share/licenses/cmux /usr/local/lib/t4");
		expect(dockerfile).toContain("COPY --chmod=0644 licenses/CMUX-TUI-MIT-NOTICE.txt");
		expect(dockerfile).toContain("COPY --chmod=0644 licenses/CMUX-UPSTREAM-LICENSE.txt");
		expect(dockerfile).toContain('org.opencontainers.image.revision="${SOURCE_COMMIT}"');
		expect(dockerfile).toContain('org.opencontainers.image.version="${IMAGE_VERSION}"');
		expect(dockerfile).toContain("RUN printf '%s' \"${SOURCE_COMMIT}\" | grep -Eq '^[0-9a-f]{40}$'");
		expect(dockerfile.lastIndexOf("USER 10001:20001")).toBeGreaterThan(dockerfile.lastIndexOf("COPY "));
	});

	test("separates shell and writer artifacts behind distinct OS principals", async () => {
		const [dockerfile, entrypoint] = await Promise.all([
			readRepositoryFile("cluster/images/session-runtime/Dockerfile"),
			readRepositoryFile("cluster/images/session-runtime/session-entrypoint.sh"),
		]);
		const finalStage = dockerfile.slice(dockerfile.lastIndexOf("\nFROM "));
		expect(finalStage).toContain("useradd --uid 10001 --gid 20001");
		expect(finalStage).toContain("useradd --uid 10002 --gid 20001");
		expect(finalStage).toContain("useradd --uid 10003 --gid 20001");
		expect(finalStage).toContain("> /usr/local/bin/omp");
		expect(finalStage).toContain("/usr/local/lib/t4/terminal-attach-client.js");
		expect(finalStage).toContain("/usr/local/lib/t4/session-credential-broker.js");
		expect(finalStage).toContain("/usr/local/lib/t4/session-runtime-readiness.js");
		expect(finalStage).toContain("> /opt/t4/libexec/omp-authority");
		expect(finalStage).toContain("chmod 0700 /opt/t4/libexec/omp-authority /opt/t4/bin/session-entrypoint");
		expect(finalStage).toContain("chmod -R go-rwx /opt/t4 /opt/omp");
		expect(finalStage).not.toContain("ENV PI_ROOT=/opt/omp");
		expect(finalStage).not.toContain("ENV T4_OMP_EXECUTABLE=");
		expect(finalStage).not.toMatch(/ENV PATH=.*libexec/u);
		expect(finalStage).not.toContain("COPY --from=t4-build /opt/t4 /opt/t4");
		expect(finalStage).toContain("/usr/local/lib/t4/session-host-main");
		expect(entrypoint).toContain("/usr/local/lib/t4/session-host-main/session-host-main.js");
		expect(finalStage).toContain("/usr/local/lib/t4/session-authority-health.js");
		expect(finalStage).toContain("/usr/local/lib/t4/assert-omp-credentials-absent.js");
	});
	test("shell entrypoint executes hostile authority-artifact and raw-socket boundary checks", async () => {
		const shellEntrypoint = await readRepositoryFile("cluster/images/session-runtime/session-shell-entrypoint.sh");
		expect(shellEntrypoint).toContain('id -u)" == "10002');
		expect(shellEntrypoint).toContain('id -g)" == "20001');
		expect(shellEntrypoint).toContain("! -r /opt/t4");
		expect(shellEntrypoint).toContain("! -x /opt/t4/libexec/omp-authority");
		expect(shellEntrypoint).toContain("! -r /opt/omp/packages/coding-agent/src/cli.ts");
		expect(shellEntrypoint).toContain('! -e "${T4_SESSION_STATE_ROOT}/private/appserver.sock"');
		expect(shellEntrypoint).toContain("seq 1 600");
		expect(shellEntrypoint).toContain('cmux_socket_dir="${T4_CMUX_SOCKET_PATH%/*}"');
		expect(shellEntrypoint).toContain('"10002:20001:770"');
		expect(shellEntrypoint).toContain("authority_artifact_exposed");
		expect(shellEntrypoint).toContain("authority_socket_exposed");
		for (const singleton of ["SingletonLock", "SingletonSocket", "SingletonCookie"])
			expect(shellEntrypoint).toContain(`"${"${T4_BROWSER_STATE_DIR}"}/${singleton}"`);
		expect(shellEntrypoint).toContain("browser_singleton_artifact_invalid");
	});
	test("keeps authority-only databases below the private runtime root", async () => {
		const sessionHost = await readRepositoryFile("packages/cluster-server/src/session-host-main.ts");
		expect(sessionHost).toContain('new TranscriptSearchIndex(join(config.privateRuntimeRoot, "transcript-search.sqlite"))');
		expect(sessionHost).not.toContain('new TranscriptSearchIndex(join(config.stateRoot, "transcript-search.sqlite"))');
		expect(sessionHost).toContain('attentionOutcomePath: join(config.privateRuntimeRoot, "attention-outcomes.json")');
		expect(sessionHost).not.toContain('attentionOutcomePath: join(config.stateRoot, "attention-outcomes.json")');
	});
	test("live proof reproduces Kubelet ownership for per-container temporary volumes and shared memory", async () => {
		const proof = await readRepositoryFile("scripts/session-runtime-live-proof.mjs");
		expect(proof).toContain('`${volumes.authority_tmp}:/authority-tmp:nocopy`');
		expect(proof).toContain('`${volumes.credential_tmp}:/credential-tmp:nocopy`');
		expect(proof).toContain('`${volumes.shell_tmp}:/shell-tmp:nocopy`');
		expect(proof).toContain('`${volumes.workspace}:/workspace:nocopy`');
		expect(proof).toContain('`${volumes.credential_broker}:/run/t4-credential:nocopy`');
		expect(proof).toContain('`${volumes.runtime}:/run/t4-runtime-shared:nocopy`');
		expect(proof).toContain('T4_CMUX_SOCKET_PATH: `/run/t4-runtime-shared/t4/${RUNTIME_ID}/cmux/c.sock`');
		expect(proof).toContain('"--tmpfs", "/dev/shm:rw,exec,nosuid,nodev,mode=1770,uid=10002,gid=20001"');
		expect(proof).toContain("chown 10002:20001 /shell-tmp");
		expect(proof).not.toContain("volumes.shm");
	});
	test("live proof exercises both packaged OMP clients against one durable session", async () => {
		const proof = await readRepositoryFile("scripts/session-runtime-live-proof.mjs");
		expect(proof).toContain('import { WebSocketPodHostConnector } from "../packages/cluster-server/src/pod-host-router.ts"');
		expect(proof).toContain("server-identity-token");
		expect(proof).toContain('"App live proof prompt"');
		expect(proof).toContain('"Terminal live proof prompt"');
		expect(proof).toContain("/usr/local/bin/omp");
		expect(proof).toContain("sharedSessionHistory");
	});
	test("live proof controls and captures a real packaged browser preview", async () => {
		const proof = await readRepositoryFile("scripts/session-runtime-live-proof.mjs");
		expect(proof).toContain('frame.type === "confirmation"');
		expect(proof).toContain('frame.summary === "preview.launch"');
		expect(proof).toContain('commandApp("preview.lease.acquire"');
		expect(proof).toContain('commandApp("preview.fill"');
		expect(proof).toContain('commandApp("preview.capture"');
		expect(proof).toContain('commandApp("preview.capture.read"');
		expect(proof).toContain("appBrowserPreview");
	});
	test("live proof creates a real cmux browser pane on the supervised CDP target", async () => {
		const proof = await readRepositoryFile("scripts/session-runtime-live-proof.mjs");
		expect(proof).toContain('"new-browser-tab"');
		expect(proof).toContain('"list-workspaces"');
		expect(proof).toContain('"http://127.0.0.1:9222/json/list"');
		expect(proof).toContain("cmuxBrowserPane");
	});
	test("live proof rejects every browser path when the runtime profile disables GUI", async () => {
		const proof = await readRepositoryFile("scripts/session-runtime-live-proof.mjs");
		expect(proof).toContain('option("gui-enabled")');
		expect(proof).toContain('T4_GUI_ENABLED: String(guiEnabled)');
		expect(proof).toContain("disabledBrowserProfile");
		expect(proof).toContain("chromiumAbsent");
		expect(proof).toContain("cmuxCdpCapabilityAbsent");
		expect(proof).toContain("previewCapabilitiesAbsent");
		expect(proof).toContain("appPreviewUnadvertised");
	});
	test("live proof replaces pod-ephemeral storage across graceful and crash restarts", async () => {
		const proof = await readRepositoryFile("scripts/session-runtime-live-proof.mjs");
		expect(proof).toContain('option("restart-proof")');
		expect(proof).toContain("/internal/runtime/quiesce");
		expect(proof).toContain("gracefulRestart");
		expect(proof).toContain("crashRestart");
		expect(proof).toContain("durableReconnect");
		expect(proof).toContain("writer_lease_live_duplicate");
		expect(proof).toContain("podEphemeralStorageReplaced");
	});
});
