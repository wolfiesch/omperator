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

test("the bundled document restricts connections without constraining the hosted web build", async () => {
  const prepareScript = await readFile(resolve(mobileRoot, "scripts/prepare-web.mjs"), "utf8");
  const hostedIndex = await readFile(resolve(mobileRoot, "../web/index.html"), "utf8");

  assert.match(prepareScript, /connect-src 'self' wss:\/\/\*\.ts\.net:\*/);
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
