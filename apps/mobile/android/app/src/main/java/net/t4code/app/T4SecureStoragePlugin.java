package net.t4code.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "T4SecureStorage")
public final class T4SecureStoragePlugin extends Plugin {
    private static final String KEYSTORE_PROVIDER = "AndroidKeyStore";
    private static final String KEY_ALIAS = "t4_code_device_credentials_v1";
    private static final String CIPHER_TRANSFORMATION = "AES/GCM/NoPadding";
    private static final String PREFERENCES_NAME = "t4_code_secure_storage";
    private static final String PREFERENCE_IV = "credentials_iv";
    private static final String PREFERENCE_PAYLOAD = "credentials_payload";
    private static final String PREFERENCE_IV_PREFIX = "credentials_iv_";
    private static final String PREFERENCE_PAYLOAD_PREFIX = "credentials_payload_";
    private static final char[] HEX_DIGITS = "0123456789abcdef".toCharArray();
    private static final int GCM_TAG_BITS = 128;
    private static final int MAX_HOST_KEY_LENGTH = 2048;
    private static final int MAX_DEVICE_ID_LENGTH = 256;
    private static final int MAX_DEVICE_TOKEN_LENGTH = 512;

    @PluginMethod
    public void getCredentials(PluginCall call) {
        String hostKey = call.getString("hostKey");
        if (!isBoundedText(hostKey, MAX_HOST_KEY_LENGTH)) {
            call.reject("Invalid host key.");
            return;
        }
        boolean migrateLegacy = Boolean.TRUE.equals(call.getBoolean("migrateLegacy", false));

        synchronized (this) {
            try {
                JSObject result = new JSObject();
                JSObject credentials = readCredentials(hostKey, migrateLegacy);
                result.put("credentials", credentials == null ? JSONObject.NULL : credentials);
                call.resolve(result);
            } catch (Exception error) {
                clearStoredStateBestEffort(hostKey);
                call.reject("Stored credentials could not be decrypted.");
            }
        }
    }

    @PluginMethod
    public void setCredentials(PluginCall call) {
        String hostKey = call.getString("hostKey");
        String deviceId = call.getString("deviceId");
        String deviceToken = call.getString("deviceToken");
        if (!isBoundedText(hostKey, MAX_HOST_KEY_LENGTH)
            || !isBoundedText(deviceId, MAX_DEVICE_ID_LENGTH)
            || !isBoundedText(deviceToken, MAX_DEVICE_TOKEN_LENGTH)) {
            call.reject("Invalid device credentials.");
            return;
        }

        synchronized (this) {
            try {
                JSObject credentials = new JSObject();
                credentials.put("deviceId", deviceId);
                credentials.put("deviceToken", deviceToken);
                storeCredentials(hostKey, credentials.toString());
                call.resolve();
            } catch (Exception error) {
                call.reject("Device credentials could not be stored.");
            }
        }
    }

    @PluginMethod
    public void clearCredentials(PluginCall call) {
        String hostKey = call.getString("hostKey");
        if (!isBoundedText(hostKey, MAX_HOST_KEY_LENGTH)) {
            call.reject("Invalid host key.");
            return;
        }

        synchronized (this) {
            try {
                clearStoredState(hostKey);
                call.resolve();
            } catch (Exception error) {
                call.reject("Device credentials could not be cleared.");
            }
        }
    }

    private boolean isBoundedText(String value, int maxLength) {
        if (value == null || value.isEmpty() || value.length() > maxLength) return false;
        for (int index = 0; index < value.length(); index += 1) {
            char character = value.charAt(index);
            if (character <= 0x1f || character == 0x7f) return false;
        }
        return true;
    }

    private SharedPreferences preferences() {
        return getContext().getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE);
    }

    private String preferenceIv(String hostKey) throws Exception {
        return PREFERENCE_IV_PREFIX + preferenceSuffix(hostKey);
    }

    private String preferencePayload(String hostKey) throws Exception {
        return PREFERENCE_PAYLOAD_PREFIX + preferenceSuffix(hostKey);
    }

    private String preferenceSuffix(String hostKey) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256")
            .digest(hostKey.getBytes(StandardCharsets.UTF_8));
        StringBuilder suffix = new StringBuilder(digest.length * 2);
        for (byte value : digest) {
            suffix.append(HEX_DIGITS[(value >>> 4) & 0x0f]);
            suffix.append(HEX_DIGITS[value & 0x0f]);
        }
        return suffix.toString();
    }

    private SecretKey getOrCreateKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER);
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) {
            return (SecretKey) keyStore.getKey(KEY_ALIAS, null);
        }

        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE_PROVIDER);
        KeyGenParameterSpec specification = new KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build();
        generator.init(specification);
        return generator.generateKey();
    }

    private void storeCredentials(String hostKey, String plaintext) throws Exception {
        storeCredentials(hostKey, plaintext, false);
    }

    private void storeCredentials(String hostKey, String plaintext, boolean removeLegacy) throws Exception {
        Cipher cipher = Cipher.getInstance(CIPHER_TRANSFORMATION);
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
        cipher.updateAAD(hostKey.getBytes(StandardCharsets.UTF_8));
        byte[] ciphertext = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));

        SharedPreferences.Editor editor = preferences().edit()
            .putString(preferenceIv(hostKey), Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
            .putString(preferencePayload(hostKey), Base64.encodeToString(ciphertext, Base64.NO_WRAP));
        if (removeLegacy) {
            editor
                .remove(PREFERENCE_IV)
                .remove(PREFERENCE_PAYLOAD);
        }
        if (!editor.commit()) throw new IllegalStateException("secure preferences commit failed");
    }

    private JSObject readCredentials(String hostKey, boolean migrateLegacy) throws Exception {
        SharedPreferences storedPreferences = preferences();
        String encodedIv = storedPreferences.getString(preferenceIv(hostKey), null);
        String encodedPayload = storedPreferences.getString(preferencePayload(hostKey), null);
        if (encodedIv != null || encodedPayload != null) {
            if (encodedIv == null || encodedPayload == null) {
                throw new IllegalStateException("incomplete keyed credential state");
            }
            return decryptCredentials(encodedIv, encodedPayload, hostKey);
        }
        if (!migrateLegacy) return null;

        String legacyIv = storedPreferences.getString(PREFERENCE_IV, null);
        String legacyPayload = storedPreferences.getString(PREFERENCE_PAYLOAD, null);
        if (legacyIv == null && legacyPayload == null) return null;
        if (legacyIv == null || legacyPayload == null) {
            throw new IllegalStateException("incomplete legacy credential state");
        }

        JSObject credentials = decryptCredentials(legacyIv, legacyPayload, null);
        storeCredentials(hostKey, credentials.toString(), true);
        return credentials;
    }

    private JSObject decryptCredentials(String encodedIv, String encodedPayload, String hostKey) throws Exception {
        byte[] iv = Base64.decode(encodedIv, Base64.NO_WRAP);
        byte[] ciphertext = Base64.decode(encodedPayload, Base64.NO_WRAP);
        Cipher cipher = Cipher.getInstance(CIPHER_TRANSFORMATION);
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(GCM_TAG_BITS, iv));
        if (hostKey != null) cipher.updateAAD(hostKey.getBytes(StandardCharsets.UTF_8));
        String plaintext = new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
        JSObject credentials = JSObject.fromJSONObject(new JSONObject(plaintext));

        String deviceId = credentials.getString("deviceId");
        String deviceToken = credentials.getString("deviceToken");
        if (!isBoundedText(deviceId, MAX_DEVICE_ID_LENGTH) || !isBoundedText(deviceToken, MAX_DEVICE_TOKEN_LENGTH)) {
            throw new IllegalStateException("invalid secure credential payload");
        }
        return credentials;
    }

    private void clearStoredState(String hostKey) throws Exception {
        if (!preferences().edit()
            .remove(preferenceIv(hostKey))
            .remove(preferencePayload(hostKey))
            .commit()) {
            throw new IllegalStateException("secure preferences clear failed");
        }
    }

    private void clearStoredStateBestEffort(String hostKey) {
        try {
            clearStoredState(hostKey);
        } catch (Exception ignored) {
            // The caller still receives a generic failure; never expose credential details.
        }
    }
}
