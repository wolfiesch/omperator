import { load as parseYaml } from "js-yaml";
import { requireText } from "./shared.mjs";

export function validateCiPolicy(context) {
  const { errors, files, ompRuntimeCommit } = context;
  const ciWorkflow = files.get(".github/workflows/ci.yml") ?? "";
  const woodpeckerWorkflow = files.get(".woodpecker.yml") ?? "";
  requireText(
    woodpeckerWorkflow,
    "https://github.com/wolfiesch/oh-my-pi.git",
    ".woodpecker.yml",
    errors,
  );
  for (const expected of [
    `git -C .current-continuity/omp fetch --depth=1 origin ${ompRuntimeCommit}`,
    `test "$(git -C .current-continuity/omp rev-parse HEAD)" = ${ompRuntimeCommit}`,
    "T4_CURRENT_OMP_SOURCE_DIR: .current-continuity/omp",
    "pnpm --filter @t4-code/host-service verify:current-omp-bridge",
  ]) {
    requireText(woodpeckerWorkflow, expected, ".woodpecker.yml", errors);
  }
  if (woodpeckerWorkflow.includes("https://github.com/lyc-aon/oh-my-pi.git")) {
    errors.push(".woodpecker.yml must not use the retired Lycaon OMP integration fork");
  }
  try {
    const workflow = parseYaml(ciWorkflow);
    const continuityJob = workflow?.jobs?.["legacy-bridge-continuity"];
    if (!continuityJob || !Array.isArray(continuityJob.steps)) {
      errors.push(".github/workflows/ci.yml is missing the legacy-bridge-continuity job");
    } else {
      const namedStep = (name) => {
        const matches = continuityJob.steps.filter((step) => step?.name === name);
        if (matches.length !== 1) {
          errors.push(`.github/workflows/ci.yml must contain exactly one ${JSON.stringify(name)} step`);
          return undefined;
        }
        return matches[0];
      };
      const authorityStep = namedStep("Resolve pinned OMP authority source");
      const checkoutStep = namedStep("Check out pinned OMP authority source");
      const continuityStep = namedStep("Run legacy bridge continuity gate");
      const uploadStep = namedStep("Upload continuity evidence");
      const authorityCommands = [
        `source_repository="$(jq -er '.verifiedRuntime.sourceRepository' compat/omp-app-matrix.json)"`,
        `test "$source_repository" = "https://github.com/wolfiesch/oh-my-pi"`,
        `sha="$(jq -er '.inputs.operationsContinuity' provenance/omp-host-migration.json)"`,
        '[[ "$sha" =~ ^[0-9a-f]{40}$ ]]',
        `echo "repository=wolfiesch/oh-my-pi" >> "$GITHUB_OUTPUT"`,
        `echo "sha=$sha" >> "$GITHUB_OUTPUT"`,
      ];
      for (const command of authorityCommands) {
        if (!authorityStep?.run?.includes(command))
          errors.push(`.github/workflows/ci.yml authority step is missing ${JSON.stringify(command)}`);
      }
      if (checkoutStep?.with?.repository !== "${{ steps.authority.outputs.repository }}")
        errors.push(".github/workflows/ci.yml continuity checkout must use the validated repository output");
      if (checkoutStep?.with?.ref !== "${{ steps.authority.outputs.sha }}")
        errors.push(".github/workflows/ci.yml continuity checkout must use the validated SHA output");
      if (checkoutStep?.with?.path !== ".continuity/omp")
        errors.push(".github/workflows/ci.yml continuity checkout must use .continuity/omp");
      if (continuityStep?.env?.T4_OMP_SOURCE_DIR !== "${{ github.workspace }}/.continuity/omp")
        errors.push(".github/workflows/ci.yml continuity gate must target the checked-out OMP source");
      if (continuityStep?.run !== "pnpm test:legacy-bridge-continuity")
        errors.push(".github/workflows/ci.yml continuity gate must run the release-bound command");
      if (
        uploadStep?.if !== "${{ always() }}" ||
        uploadStep?.with?.path !== "artifacts/legacy-bridge-continuity/" ||
        uploadStep?.with?.["if-no-files-found"] !== "error"
      )
        errors.push(".github/workflows/ci.yml continuity evidence upload is not fail-closed");
    }
    const currentJob = workflow?.jobs?.["current-bridge-continuity"];
    if (!currentJob || !Array.isArray(currentJob.steps)) {
      errors.push(".github/workflows/ci.yml is missing the current-bridge-continuity job");
    } else {
      const namedCurrentStep = (name) => {
        const matches = currentJob.steps.filter((step) => step?.name === name);
        if (matches.length !== 1) {
          errors.push(`.github/workflows/ci.yml must contain exactly one ${JSON.stringify(name)} step`);
          return undefined;
        }
        return matches[0];
      };
      const authorityStep = namedCurrentStep("Resolve current OMP authority source");
      const checkoutStep = namedCurrentStep("Check out current OMP authority source");
      const sourceTestStep = namedCurrentStep("Run current OMP authority source tests");
      const proofStep = namedCurrentStep("Run current bridge compatibility proof");
      const uploadStep = namedCurrentStep("Upload current bridge evidence");
      for (const command of [
        `source_repository="$(jq -er '.verifiedRuntime.sourceRepository' compat/omp-app-matrix.json)"`,
        `test "$source_repository" = "https://github.com/wolfiesch/oh-my-pi"`,
        `sha="$(jq -er '.verifiedRuntime.sourceCommit' compat/omp-app-matrix.json)"`,
        '[[ "$sha" =~ ^[0-9a-f]{40}$ ]]',
        `echo "repository=wolfiesch/oh-my-pi" >> "$GITHUB_OUTPUT"`,
        `echo "sha=$sha" >> "$GITHUB_OUTPUT"`,
      ]) {
        if (!authorityStep?.run?.includes(command))
          errors.push(`.github/workflows/ci.yml current authority step is missing ${JSON.stringify(command)}`);
      }
      if (checkoutStep?.with?.repository !== "${{ steps.current-authority.outputs.repository }}")
        errors.push(".github/workflows/ci.yml current checkout must use the validated repository output");
      if (checkoutStep?.with?.ref !== "${{ steps.current-authority.outputs.sha }}")
        errors.push(".github/workflows/ci.yml current checkout must use the validated SHA output");
      if (checkoutStep?.with?.path !== ".current-continuity/omp")
        errors.push(".github/workflows/ci.yml current checkout must use .current-continuity/omp");
      if (
        sourceTestStep?.["working-directory"] !== ".current-continuity/omp" ||
        sourceTestStep?.run !==
          "bun test packages/coding-agent/test/appserver-bridge.test.ts packages/coding-agent/test/appserver-session-lifecycle.test.ts"
      )
        errors.push(".github/workflows/ci.yml current authority source tests are incomplete");
      if (
        proofStep?.env?.T4_CURRENT_OMP_SOURCE_DIR !==
          "${{ github.workspace }}/.current-continuity/omp" ||
        proofStep?.run !== "pnpm --filter @t4-code/host-service verify:current-omp-bridge"
      )
        errors.push(".github/workflows/ci.yml current bridge proof must target the checked-out current source");
      if (
        uploadStep?.if !== "${{ success() }}" ||
        uploadStep?.with?.path !== "artifacts/current-omp-bridge/" ||
        uploadStep?.with?.["if-no-files-found"] !== "error"
      )
        errors.push(".github/workflows/ci.yml current bridge evidence upload is not fail-closed");
    }
    // Release-time gates are deferred to pushes and must stay covered by the
    // merge run; every other leg must keep blocking pull requests.
    for (const job of ["legacy-bridge-continuity", "official-omp-gate0"]) {
      const expected = `\${{ github.event_name == 'push' && needs.changes.outputs.${job === "official-omp-gate0" ? "official_omp_gate0" : "continuity"} == 'true' }}`;
      if (workflow?.jobs?.[job]?.if !== expected)
        errors.push(`.github/workflows/ci.yml ${job} must run only on pushes for its affected paths`);
    }
    for (const [job, output] of [
      ["current-bridge-continuity", "continuity"],
      ["cluster", "cluster"],
      ["tooling", "tooling"],
      ["maintainer", "maintainer"],
      ["android-debug", "android_debug"],
    ]) {
      if (
        workflow?.jobs?.[job]?.if !==
        `\${{ needs.changes.outputs.${output} == 'true' }}`
      )
        errors.push(
          `.github/workflows/ci.yml ${job} must follow its path classification on pull requests, merge groups, and pushes`,
        );
    }
    for (const job of ["check", "unit-tests", "build-e2e", "t4-api-generation"]) {
      if (workflow?.jobs?.[job]?.if !== undefined)
        errors.push(`.github/workflows/ci.yml ${job} must run unconditionally`);
    }
    // The required branch-protection gate must not wait on any leg that runs
    // off ubuntu-24.04, and those legs must stay aggregated by release-gates so
    // a failure still fails the run the release waiter reads. `ios` is in this
    // set because it runs on macOS, not because it is deferred: unlike the
    // release gates it also runs on pull requests.
    const verifyNeeds = workflow?.jobs?.verify?.needs ?? [];
    for (const job of ["legacy-bridge-continuity", "official-omp-gate0", "ios"]) {
      if (verifyNeeds.includes(job))
        errors.push(`.github/workflows/ci.yml verify must not wait on the ${job} leg`);
      if (!(workflow?.jobs?.["release-gates"]?.needs ?? []).includes(job))
        errors.push(`.github/workflows/ci.yml release-gates must aggregate the ${job} leg`);
    }
    // The iOS leg is path-gated, so a broken gate would silently ship Swift
    // that no job ever compiled. Its persistent runner is restricted to
    // same-repository pull requests; every other event uses disposable macOS.
    if (workflow?.jobs?.ios?.if !== "${{ needs.changes.outputs.ios == 'true' }}")
      errors.push(".github/workflows/ci.yml ios must be gated on needs.changes.outputs.ios");
    const expectedIosRunner =
      "${{ fromJSON(github.event_name == 'pull_request' && github.event.pull_request.head.repo.full_name == github.repository && vars.M1_CI_ENABLED == 'true' && '[\"self-hosted\",\"macOS\",\"ARM64\",\"wolfie-m1\",\"trusted\"]' || '\"macos-26\"') }}";
    if (workflow?.jobs?.ios?.["runs-on"] !== expectedIosRunner)
      errors.push(
        ".github/workflows/ci.yml ios must reserve the M1 for trusted same-repository pull requests and otherwise use hosted macOS",
      );
    if (workflow?.jobs?.changes?.outputs?.ios !== "${{ steps.classify.outputs.ios }}")
      errors.push(".github/workflows/ci.yml changes must export the ios classification");
    // A merge run may only narrow its legs against a commit whose own run was
    // green. Diffing the immediate parent would let a docs-only run inherit
    // proof across a failed one, and the release waiter reads exactly that
    // per-commit conclusion.
    const classifyStep = (workflow?.jobs?.changes?.steps ?? []).find(
      (step) => step?.id === "classify",
    );
    if (typeof classifyStep?.run !== "string") {
      errors.push(".github/workflows/ci.yml is missing the classify step");
    } else {
      if (!classifyStep.run.includes("node scripts/ci-baseline.mjs --head"))
        errors.push(".github/workflows/ci.yml pushes must classify against a proven baseline");
      if (!classifyStep.run.includes('node scripts/ci-paths.mjs --all'))
        errors.push(".github/workflows/ci.yml must widen to every leg without a proven baseline");
      if (!/github\.event\.pull_request\.base\.sha/u.test(JSON.stringify(classifyStep.env ?? {})))
        errors.push(".github/workflows/ci.yml must classify pull requests against their base");
    }
    if (workflow?.jobs?.changes?.permissions?.actions !== "read")
      errors.push(".github/workflows/ci.yml changes must read Actions history to find a baseline");
    // The classifier cannot grade itself, so a change to selection or to the
    // release authority that trusts a run conclusion must widen to every leg.
    const classifierSource = files.get("scripts/ci-paths.mjs") ?? "";
    for (const boundary of [
      String.raw`^\.github\/workflows\/(?:ci|release)\.yml$`,
      String.raw`^scripts\/check-release-consistency(?:\.test)?\.mjs$`,
      String.raw`^scripts\/release-consistency\/`,
      String.raw`^scripts\/ci-baseline(?:\.test)?\.mjs$`,
      String.raw`^scripts\/ci-paths(?:\.test)?\.mjs$`,
      String.raw`^scripts\/wait-for-exact-ci(?:\.test)?\.mjs$`,
    ]) {
      if (!classifierSource.includes(boundary))
        errors.push(`scripts/ci-paths.mjs must force every leg for ${boundary}`);
    }
  } catch (error) {
    errors.push(`.github/workflows/ci.yml is invalid YAML: ${error instanceof Error ? error.message : error}`);
  }

  for (const expected of [
    "check:",
    "unit-tests:",
    "build-e2e:",
    "path: ~/.cache/ms-playwright",
    "key: playwright-v1-${{ runner.os }}-${{ runner.arch }}-${{ hashFiles('pnpm-lock.yaml') }}",
    "run: pnpm exec playwright install --with-deps chromium",
    "run: pnpm exec playwright install-deps chromium",
    "key: ${{ steps.playwright-cache.outputs.cache-primary-key }}",
    "run: node --test scripts/ci-paths.test.mjs scripts/ci-baseline.test.mjs",
    "legacy-bridge-continuity:",
    'ref: ${{ github.event.pull_request.head.sha || github.sha }}',
    `source_repository="$(jq -er '.verifiedRuntime.sourceRepository' compat/omp-app-matrix.json)"`,
    `test "$source_repository" = "https://github.com/wolfiesch/oh-my-pi"`,
    `sha="$(jq -er '.inputs.operationsContinuity' provenance/omp-host-migration.json)"`,
    '[[ "$sha" =~ ^[0-9a-f]{40}$ ]]',
    `echo "repository=wolfiesch/oh-my-pi" >> "$GITHUB_OUTPUT"`,
    "repository: ${{ steps.authority.outputs.repository }}",
    "ref: ${{ steps.authority.outputs.sha }}",
    "T4_OMP_SOURCE_DIR: ${{ github.workspace }}/.continuity/omp",
    "run: pnpm test:legacy-bridge-continuity",
    "path: artifacts/legacy-bridge-continuity/",
    "if-no-files-found: error",
    "current-bridge-continuity:",
    `sha="$(jq -er '.verifiedRuntime.sourceCommit' compat/omp-app-matrix.json)"`,
    "repository: ${{ steps.current-authority.outputs.repository }}",
    "ref: ${{ steps.current-authority.outputs.sha }}",
    "T4_CURRENT_OMP_SOURCE_DIR: ${{ github.workspace }}/.current-continuity/omp",
    "run: pnpm --filter @t4-code/host-service verify:current-omp-bridge",
    "path: artifacts/current-omp-bridge/",
    "official-omp-gate0:",
    "runner: ubuntu-24.04-arm",
    "run: pnpm --filter @t4-code/host-service verify:official-omp-lifecycle",
    "run: pnpm --filter @t4-code/host-daemon verify:official-omp-packaged",
    "artifacts/official-omp-gate0/${{ matrix.platform }}.json",
    "artifacts/official-omp-packaged-host/${{ matrix.platform }}.json",
    "tooling:",
    "maintainer:",
    "run: pnpm test:tooling",
    "run: pnpm test:maintainer",
    "cluster:",
    "actions/setup-go@924ae3a1cded613372ab5595356fb5720e22ba16",
    "run: pnpm test:cluster:ci",
    "run: go test ./...",
    "run: helm lint deploy/charts/t4-cluster",
    "android-debug:",
    "name: verify",
    "if: ${{ always() }}",
    "needs: [changes, t4-api-generation, check, unit-tests, build-e2e, current-bridge-continuity, cluster, tooling, maintainer, android-debug]",
    "name: release-gates",
    "needs: [changes, legacy-bridge-continuity, official-omp-gate0, ios]",
    "ios:",
    "run: node scripts/verify-ios.mjs",
    "IOS_RESULT: ${{ needs.ios.result }}",
    'test "$CHANGES_RESULT" = success',
    'test "$T4_API_GENERATION_RESULT" = success',
    'test "$CHECK_RESULT" = success',
    'test "$UNIT_TESTS_RESULT" = success',
    'test "$BUILD_E2E_RESULT" = success',
    "OFFICIAL_OMP_GATE0_RESULT: ${{ needs.official-omp-gate0.result }}",
    "CURRENT_CONTINUITY_RESULT: ${{ needs.current-bridge-continuity.result }}",
    '"$CURRENT_CONTINUITY_RESULT" \\',
    "for result in \\",
    "success|skipped) ;;",
    "github.event_name == 'pull_request' && github.ref || github.sha",
    "cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    "actions/setup-java@c1e323688fd81a25caa38c78aa6df2d33d3e20d9",
    "android-actions/setup-android@9fc6c4e9069bf8d3d10b2204b1fb8f6ef7065407",
    'sdkmanager --install "platforms;android-36" "build-tools;36.0.0"',
    "pnpm --filter @t4-code/mobile check:android:debug",
  ]) {
    requireText(ciWorkflow, expected, ".github/workflows/ci.yml", errors);
  }

}
