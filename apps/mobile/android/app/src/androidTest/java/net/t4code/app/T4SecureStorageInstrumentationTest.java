package net.t4code.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.SystemClock;
import android.webkit.WebView;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;

import com.getcapacitor.Bridge;

import org.json.JSONObject;
import org.json.JSONTokener;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import android.util.Base64;

@RunWith(AndroidJUnit4.class)
public final class T4SecureStorageInstrumentationTest {
    private static final String PREFERENCES_NAME = "t4_code_secure_storage";
    private static final String LEGACY_IV = "credentials_iv";
    private static final String LEGACY_PAYLOAD = "credentials_payload";
    private static final String KEY_ALIAS = "t4_code_device_credentials_v1";
    private static final String KEYSTORE_PROVIDER = "AndroidKeyStore";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final String HOST_A = "android-instrumentation-host-a";
    private static final String HOST_B = "android-instrumentation-host-b";

    private ActivityScenario<MainActivity> scenario;
    private Context targetContext;

    @Before
    public void setUp() throws Exception {
        targetContext = InstrumentationRegistry.getInstrumentation().getTargetContext();
        targetContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE).edit().clear().commit();
        scenario = ActivityScenario.launch(MainActivity.class);
        awaitPluginReady();
    }

    @After
    public void tearDown() {
        if (scenario != null) scenario.close();
    }

    @Test
    public void hostScopedCredentialsPersistAcrossRecreationAndDeleteOnlyOneHost() throws Exception {
        invokeSet(HOST_A, "synthetic-device-a", "synthetic-token-a");
        invokeSet(HOST_B, "synthetic-device-b", "synthetic-token-b");

        assertCredentials(HOST_A, "synthetic-device-a", "synthetic-token-a");
        assertCredentials(HOST_B, "synthetic-device-b", "synthetic-token-b");

        scenario.recreate();
        awaitPluginReady();
        assertCredentials(HOST_A, "synthetic-device-a", "synthetic-token-a");
        assertCredentials(HOST_B, "synthetic-device-b", "synthetic-token-b");

        invokeClear(HOST_A);
        assertNullCredentials(HOST_A);
        assertCredentials(HOST_B, "synthetic-device-b", "synthetic-token-b");
    }

    @Test
    public void hostBoundAadRejectsCiphertextCopiedAcrossHosts() throws Exception {
        invokeSet(HOST_A, "aad-device-a", "aad-token-a");

        SharedPreferences preferences = targetContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE);
        String sourceSuffix = preferenceSuffix(HOST_A);
        String targetSuffix = preferenceSuffix(HOST_B);
        String iv = preferences.getString("credentials_iv_" + sourceSuffix, null);
        String payload = preferences.getString("credentials_payload_" + sourceSuffix, null);
        assertNotNull(iv);
        assertNotNull(payload);
        assertTrue(preferences.edit()
            .putString("credentials_iv_" + targetSuffix, iv)
            .putString("credentials_payload_" + targetSuffix, payload)
            .commit());

        JSONObject rejected = invokeGet(HOST_B, false);
        assertFalse(rejected.getBoolean("ok"));
        assertEquals("Stored credentials could not be decrypted.", rejected.getString("message"));
        assertCredentials(HOST_A, "aad-device-a", "aad-token-a");
        assertNullCredentials(HOST_B);
    }

    @Test
    public void legacyV1CredentialsMigrateToHostScopedStorageWithoutLeavingLegacyState() throws Exception {
        // Generate the production key through the real plugin path before seeding legacy v1 state.
        invokeSet(HOST_A, "temporary-device", "temporary-token");
        invokeClear(HOST_A);
        SharedPreferences preferences = targetContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE);
        assertTrue(preferences.edit().clear().commit());
        seedLegacyCredentials("legacy-device", "legacy-token");

        assertNullCredentials(HOST_A);
        assertCredentials(HOST_A, "legacy-device", "legacy-token", true);

        assertNull(preferences.getString(LEGACY_IV, null));
        assertNull(preferences.getString(LEGACY_PAYLOAD, null));
        String suffix = preferenceSuffix(HOST_A);
        assertNotNull(preferences.getString("credentials_iv_" + suffix, null));
        assertNotNull(preferences.getString("credentials_payload_" + suffix, null));

        scenario.recreate();
        awaitPluginReady();
        assertCredentials(HOST_A, "legacy-device", "legacy-token");
    }

    @Test
    public void nativeResumeEventIsObservableAfterBackgroundAndResume() throws Exception {
        runJavascript("window.__t4NativeResumeCount = 0; window.addEventListener('t4:native-resume', () => { window.__t4NativeResumeCount += 1; }); 'installed';");

        scenario.moveToState(androidx.lifecycle.Lifecycle.State.STARTED);
        scenario.moveToState(androidx.lifecycle.Lifecycle.State.RESUMED);

        long deadline = SystemClock.uptimeMillis() + 5_000L;
        int count = 0;
        while (SystemClock.uptimeMillis() < deadline) {
            String value = readJavascript("String(window.__t4NativeResumeCount || 0)");
            count = Integer.parseInt(value);
            if (count > 0) break;
            SystemClock.sleep(100L);
        }
        assertTrue("native resume event was not observed", count > 0);
    }

    private void invokeSet(String hostKey, String deviceId, String deviceToken) throws Exception {
        JSONObject result = invoke(String.format("""
            const plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.T4SecureStorage;
            if (!plugin) throw new Error('T4SecureStorage plugin unavailable');
            await plugin.setCredentials({hostKey: %s, deviceId: %s, deviceToken: %s});
            """, JSONObject.quote(hostKey), JSONObject.quote(deviceId), JSONObject.quote(deviceToken)));
        assertTrue(result.getBoolean("ok"));
    }

    private void invokeClear(String hostKey) throws Exception {
        JSONObject result = invoke(String.format("""
            const plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.T4SecureStorage;
            if (!plugin) throw new Error('T4SecureStorage plugin unavailable');
            await plugin.clearCredentials({hostKey: %s});
            """, JSONObject.quote(hostKey)));
        assertTrue(result.getBoolean("ok"));
    }

    private void assertCredentials(String hostKey, String deviceId, String deviceToken) throws Exception {
        assertCredentials(hostKey, deviceId, deviceToken, false);
    }

    private void assertCredentials(String hostKey, String deviceId, String deviceToken, boolean migrateLegacy) throws Exception {
        JSONObject result = invokeGet(hostKey, migrateLegacy);
        assertTrue(result.getBoolean("ok"));
        JSONObject credentials = result.getJSONObject("value");
        assertEquals(deviceId, credentials.getString("deviceId"));
        assertEquals(deviceToken, credentials.getString("deviceToken"));
    }

    private void assertNullCredentials(String hostKey) throws Exception {
        JSONObject result = invokeGet(hostKey, false);
        assertTrue(result.getBoolean("ok"));
        assertTrue(result.isNull("value"));
    }

    private JSONObject invokeGet(String hostKey, boolean migrateLegacy) throws Exception {
        return invoke(String.format("""
            const plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.T4SecureStorage;
            if (!plugin) throw new Error('T4SecureStorage plugin unavailable');
            const response = await plugin.getCredentials({hostKey: %s, migrateLegacy: %s});
            return response.credentials === null ? null : response.credentials;
            """, JSONObject.quote(hostKey), migrateLegacy ? "true" : "false"));
    }

    private JSONObject invoke(String body) throws Exception {
        runJavascript(String.format("""
            window.__t4InstrumentationResult = null;
            (async () => {
                try {
                    const value = await (async () => { %s })();
                    window.__t4InstrumentationResult = JSON.stringify({ok: true, value: value === undefined ? null : value});
                } catch (error) {
                    window.__t4InstrumentationResult = JSON.stringify({ok: false, message: String(error && error.message || error)});
                }
            })();
            'started';
            """, body));
        long deadline = SystemClock.uptimeMillis() + 10_000L;
        while (SystemClock.uptimeMillis() < deadline) {
            String encoded = readJavascript("window.__t4InstrumentationResult || ''");
            if (!encoded.isEmpty()) return new JSONObject(encoded);
            SystemClock.sleep(100L);
        }
        throw new AssertionError("Timed out waiting for native plugin result");
    }

    private void awaitPluginReady() throws Exception {
        long deadline = SystemClock.uptimeMillis() + 20_000L;
        while (SystemClock.uptimeMillis() < deadline) {
            if ("ready".equals(readJavascript("typeof window.Capacitor?.Plugins?.T4SecureStorage === 'object' ? 'ready' : 'pending'"))) return;
            SystemClock.sleep(100L);
        }
        throw new AssertionError("T4SecureStorage plugin did not become available");
    }

    private void seedLegacyCredentials(String deviceId, String deviceToken) throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER);
        keyStore.load(null);
        SecretKey key = (SecretKey) keyStore.getKey(KEY_ALIAS, null);
        assertNotNull(key);

        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.ENCRYPT_MODE, key);
        String plaintext = new JSONObject().put("deviceId", deviceId).put("deviceToken", deviceToken).toString();
        byte[] payload = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
        SharedPreferences preferences = targetContext.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE);
        assertTrue(preferences.edit()
            .putString(LEGACY_IV, Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
            .putString(LEGACY_PAYLOAD, Base64.encodeToString(payload, Base64.NO_WRAP))
            .commit());
    }

    private String preferenceSuffix(String hostKey) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(hostKey.getBytes(StandardCharsets.UTF_8));
        StringBuilder suffix = new StringBuilder(digest.length * 2);
        for (byte value : digest) suffix.append(String.format("%02x", value & 0xff));
        return suffix.toString();
    }

    private void runJavascript(String script) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<Throwable> failure = new AtomicReference<>();
        scenario.onActivity(activity -> {
            Bridge bridge = activity.getBridge();
            if (bridge == null || bridge.getWebView() == null) {
                failure.set(new AssertionError("Capacitor bridge WebView unavailable"));
                latch.countDown();
                return;
            }
            bridge.getWebView().evaluateJavascript(script, ignored -> latch.countDown());
        });
        if (!latch.await(5, TimeUnit.SECONDS)) throw new AssertionError("Timed out evaluating JavaScript");
        if (failure.get() != null) throw new AssertionError(failure.get());
    }

    private String readJavascript(String script) throws Exception {
        CountDownLatch latch = new CountDownLatch(1);
        AtomicReference<String> result = new AtomicReference<>();
        AtomicReference<Throwable> failure = new AtomicReference<>();
        scenario.onActivity(activity -> {
            WebView webView = activity.getBridge().getWebView();
            webView.evaluateJavascript(script, value -> {
                try {
                    Object decoded = new JSONTokener(value).nextValue();
                    result.set(decoded == null ? "" : String.valueOf(decoded));
                } catch (Exception error) {
                    failure.set(error);
                }
                latch.countDown();
            });
        });
        if (!latch.await(5, TimeUnit.SECONDS)) throw new AssertionError("Timed out reading JavaScript");
        if (failure.get() != null) throw new AssertionError(failure.get());
        return result.get();
    }
}
