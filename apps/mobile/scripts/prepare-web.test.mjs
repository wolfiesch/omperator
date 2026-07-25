import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const mobileRoot = resolve(import.meta.dirname, "..");

test("Capacitor uses bundled assets and a local secure origin", async () => {
  const config = JSON.parse(await readFile(resolve(mobileRoot, "capacitor.config.json"), "utf8"));

  assert.equal(config.webDir, "dist");
  assert.equal(config.server.hostname, "localhost");
  assert.equal(config.server.androidScheme, "https");
  assert.equal(config.server.url, undefined);
  assert.equal(config.server.allowNavigation, undefined);
  assert.equal(config.server.cleartext, undefined);
});

test("Android system bars hand insets to CSS through the SystemBars plugin", async () => {
  const config = JSON.parse(await readFile(resolve(mobileRoot, "capacitor.config.json"), "utf8"));
  const hostedIndex = await readFile(resolve(mobileRoot, "../web/index.html"), "utf8");
  const systemBars = await readFile(
    resolve(
      mobileRoot,
      "node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/plugin/SystemBars.java",
    ),
    "utf8",
  );

  // Capacitor 8 core registers SystemBars itself; the config keeps the CSS
  // variable injection (--safe-area-inset-*) explicit so the web token layer
  // always has a value on Android WebViews where env() misreports.
  assert.equal(config.plugins.SystemBars.insetsHandling, "css");
  assert.match(hostedIndex, /viewport-fit=cover/);
  assert.match(systemBars, /--safe-area-inset-top/);
  assert.match(systemBars, /--safe-area-inset-bottom/);
});

test("mobile package pins one Capacitor release across core, CLI, and Android", async () => {
  const packageJson = JSON.parse(await readFile(resolve(mobileRoot, "package.json"), "utf8"));
  const core = packageJson.dependencies["@capacitor/core"];

  assert.equal(core, "8.4.1");
  assert.equal(packageJson.devDependencies["@capacitor/cli"], core);
  assert.equal(packageJson.devDependencies["@capacitor/android"], core);
});

test("Android credentials are encrypted by a registered Keystore plugin", async () => {
  const sourceRoot = resolve(
    mobileRoot,
    "android/app/src/main/java/com/lycaonsolutions/t4code",
  );
  const activity = await readFile(resolve(sourceRoot, "MainActivity.java"), "utf8");
  const plugin = await readFile(resolve(sourceRoot, "T4SecureStoragePlugin.java"), "utf8");

  assert.match(activity, /registerPlugin\(T4SecureStoragePlugin\.class\)/);
  assert.match(plugin, /@CapacitorPlugin\(name = "T4SecureStorage"\)/);
  assert.match(plugin, /AES\/GCM\/NoPadding/);
  assert.match(plugin, /AndroidKeyStore/);
  assert.match(plugin, /setCredentials\(PluginCall call\)/);
  assert.match(plugin, /getCredentials\(PluginCall call\)/);
  assert.match(plugin, /clearCredentials\(PluginCall call\)/);
  assert.doesNotMatch(plugin, /putString\([^,]+,\s*deviceToken\)/);
});

test("Android secure credentials are host-scoped and migrate legacy storage", async () => {
  const sourceRoot = resolve(
    mobileRoot,
    "android/app/src/main/java/com/lycaonsolutions/t4code",
  );
  const plugin = await readFile(resolve(sourceRoot, "T4SecureStoragePlugin.java"), "utf8");

  assert.match(plugin, /call\.getString\("hostKey"\)/);
  assert.match(plugin, /MAX_HOST_KEY_LENGTH/);
  assert.equal((plugin.match(/String hostKey = call\.getString\("hostKey"\)/g) ?? []).length, 3);
  assert.equal((plugin.match(/isBoundedText\(hostKey, MAX_HOST_KEY_LENGTH\)/g) ?? []).length, 3);
  assert.match(plugin, /call\.getBoolean\("migrateLegacy", false\)/);
  assert.match(plugin, /readCredentials\(hostKey, migrateLegacy\)/);
  assert.match(plugin, /if \(!migrateLegacy\) return null/);
  assert.match(plugin, /MessageDigest\.getInstance\("SHA-256"\)/);
  assert.match(plugin, /PREFERENCE_IV_PREFIX/);
  assert.match(plugin, /PREFERENCE_PAYLOAD_PREFIX/);
  assert.match(plugin, /preferenceIv\(hostKey\)/);
  assert.match(plugin, /preferencePayload\(hostKey\)/);
  assert.match(plugin, /cipher\.updateAAD\(hostKey\.getBytes\(StandardCharsets\.UTF_8\)\)/);
  assert.match(plugin, /putString\(preferenceIv\(hostKey\), Base64\.encodeToString/);
  assert.match(plugin, /putString\(preferencePayload\(hostKey\), Base64\.encodeToString/);
  assert.match(plugin, /decryptCredentials\(legacyIv, legacyPayload, null\)/);
  assert.match(plugin, /storeCredentials\(hostKey, credentials\.toString\(\), true\)/);
  assert.match(plugin, /SharedPreferences\.Editor editor = preferences\(\)\.edit\(\)/);
  assert.match(plugin, /if \(removeLegacy\)/);
  assert.match(plugin, /PREFERENCE_IV = "credentials_iv"/);
  assert.match(plugin, /PREFERENCE_PAYLOAD = "credentials_payload"/);
  assert.match(plugin, /remove\(PREFERENCE_IV\)/);
  assert.doesNotMatch(plugin, /storedPreferences\.edit\(\)\s*\.remove\(PREFERENCE_IV\)/);
  assert.match(plugin, /remove\(PREFERENCE_PAYLOAD\)/);
  assert.match(plugin, /clearStoredState\(hostKey\)/);
  assert.doesNotMatch(plugin, /preferences\(\)\.edit\(\)\.clear\(\)/);
  assert.doesNotMatch(plugin, /keyStore\.deleteEntry\(KEY_ALIAS\)/);
  assert.doesNotMatch(plugin, /putString\([^)]*deviceToken/);
  assert.doesNotMatch(plugin, /putString\([^)]*"deviceToken"/);
});

test("Android foreground resume wakes the browser connection immediately", async () => {
  const activity = await readFile(
    resolve(
      mobileRoot,
      "android/app/src/main/java/com/lycaonsolutions/t4code/MainActivity.java",
    ),
    "utf8",
  );

  assert.match(activity, /void onResume\(\)/);
  assert.match(activity, /super\.onResume\(\)/);
  assert.match(activity, /triggerWindowJSEvent\(APP_RESUME_EVENT\)/);
  assert.match(activity, /APP_RESUME_EVENT = "t4:native-resume"/);
});

test("Android updates use a registered native bridge with no renderer-supplied URL", async () => {
  const sourceRoot = resolve(
    mobileRoot,
    "android/app/src/main/java/com/lycaonsolutions/t4code",
  );
  const activity = await readFile(resolve(sourceRoot, "MainActivity.java"), "utf8");
  const fileProvider = await readFile(resolve(sourceRoot, "T4FileProvider.java"), "utf8");
  const fileStore = await readFile(resolve(sourceRoot, "T4UpdateFileStore.java"), "utf8");
  const plugin = await readFile(resolve(sourceRoot, "T4UpdatePlugin.java"), "utf8");
  const verifier = await readFile(resolve(sourceRoot, "T4UpdateVerifier.java"), "utf8");
  const manifest = await readFile(resolve(mobileRoot, "android/app/src/main/AndroidManifest.xml"), "utf8");
  const providerPaths = await readFile(
    resolve(mobileRoot, "android/app/src/main/res/xml/file_paths.xml"),
    "utf8",
  );

  assert.match(activity, /registerPlugin\(T4UpdatePlugin\.class\)/);
  assert.match(plugin, /@CapacitorPlugin\(name = "T4Update"\)/);
  assert.match(plugin, /https:\/\/t4code\.net\/releases\/latest\.json/);
  assert.match(verifier, /https:\/\/github\.com\/wolfiesch\/omperator\/releases\/download\//);
  assert.match(plugin, /checkForUpdate\(PluginCall call\)/);
  assert.match(plugin, /openUpdate\(PluginCall call\)/);
  assert.match(plugin, /T4UpdateVerifier\.copyExact\(input, output, release\.apkSize, release\.apkSha256\)/);
  assert.match(plugin, /EXPECTED_PACKAGE_ID = "com\.lycaonsolutions\.t4code"/);
  assert.match(plugin, /expectedVersion\.equals\(candidate\.versionName\)/);
  assert.match(plugin, /PackageManager\.GET_SIGNING_CERTIFICATES/);
  assert.match(plugin, /PackageManager\.GET_SIGNATURES/);
  assert.match(plugin, /getSigningCertificateHistory\(\)/);
  assert.match(plugin, /T4UpdateVerifier\.isTrustedSignerTransition\(/);
  assert.match(plugin, /T4UpdateVerifier\.sameSignerSet\(legacySigners\(installed\), legacySigners\(candidate\)\)/);
  assert.match(fileStore, /File\.createTempFile\("T4-Code-" \+ version/);
  assert.match(fileStore, /verified\.setReadOnly\(\)/);
  assert.match(fileStore, /ACTIVE_OWNERS\.put\(ownershipKey, ownerToken\)/);
  assert.match(fileStore, /requireOwnership\(\)/);
  assert.match(plugin, /updateState\.installerOpened\(\)/);
  assert.match(plugin, /notifyListeners\(STATE_CHANGED_EVENT, state\)/);
  assert.match(plugin, /result\.put\("revision", updateState\.revision\(\)\)/);
  assert.match(plugin, /BuildConfig\.APPLICATION_ID/);
  assert.match(plugin, /BuildConfig\.VERSION_NAME/);
  assert.match(plugin, /FileProvider\.getUriForFile/);
  assert.match(plugin, /new Intent\(Intent\.ACTION_VIEW\)/);
  assert.match(plugin, /Intent\.FLAG_GRANT_READ_URI_PERMISSION/);
  assert.match(verifier, /count > expectedSize - total/);
  assert.match(verifier, /total != expectedSize/);
  assert.match(verifier, /MessageDigest\.getInstance\("SHA-256"\)/);
  assert.match(manifest, /android\.permission\.REQUEST_INSTALL_PACKAGES/);
  assert.match(fileProvider, /final class T4FileProvider extends FileProvider/);
  assert.match(manifest, /android:name="\.T4FileProvider"/);
  assert.match(providerPaths, /<cache-path name="verified_updates" path="t4-updates\/" \/>/);
  assert.doesNotMatch(providerPaths, /<external-path/);
  assert.doesNotMatch(providerPaths, /path="\."/);
  assert.doesNotMatch(plugin, /call\.getString\("(?:url|uri|path)"\)/);
  assert.doesNotMatch(plugin, /setInstanceFollowRedirects\(true\)/);
  assert.doesNotMatch(plugin, /CATEGORY_BROWSABLE/);
  assert.doesNotMatch(plugin, /android\.content\.pm\.PackageInstaller|PackageInstaller\.Session/);
  assert.doesNotMatch(plugin, /validatedApkUrl/);
  assert.doesNotMatch(plugin, /return "0\.0\.0"/);
});

test("the bundled document restricts connections without constraining the hosted web build", async () => {
  const prepareScript = await readFile(resolve(mobileRoot, "scripts/prepare-web.mjs"), "utf8");
  const hostedIndex = await readFile(resolve(mobileRoot, "../web/index.html"), "utf8");

  assert.match(prepareScript, /connect-src 'self' wss:\/\/\*\.ts\.net:\*/);
  assert.match(prepareScript, /img-src 'self' data: blob:/);
  assert.match(prepareScript, /http-equiv="Content-Security-Policy"/);
  assert.doesNotMatch(prepareScript, /connect-src \*/);
  assert.doesNotMatch(hostedIndex, /http-equiv="Content-Security-Policy"/);
});

test("the Android build verifies its Gradle distribution", async () => {
  const wrapper = await readFile(
    resolve(mobileRoot, "android/gradle/wrapper/gradle-wrapper.properties"),
    "utf8",
  );

  assert.match(wrapper, /^distributionSha256Sum=[a-f0-9]{64}$/mu);
  assert.match(wrapper, /^validateDistributionUrl=true$/mu);
});
