package com.lycaonsolutions.t4code;

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
    private static final int GCM_TAG_BITS = 128;
    private static final int MAX_DEVICE_ID_LENGTH = 256;
    private static final int MAX_DEVICE_TOKEN_LENGTH = 512;

    @PluginMethod
    public void getCredentials(PluginCall call) {
        synchronized (this) {
            try {
                JSObject result = new JSObject();
                JSObject credentials = readCredentials();
                result.put("credentials", credentials == null ? JSONObject.NULL : credentials);
                call.resolve(result);
            } catch (Exception error) {
                clearStoredStateBestEffort();
                call.reject("Stored credentials could not be decrypted.");
            }
        }
    }

    @PluginMethod
    public void setCredentials(PluginCall call) {
        String deviceId = call.getString("deviceId");
        String deviceToken = call.getString("deviceToken");
        if (!isBoundedText(deviceId, MAX_DEVICE_ID_LENGTH) || !isBoundedText(deviceToken, MAX_DEVICE_TOKEN_LENGTH)) {
            call.reject("Invalid device credentials.");
            return;
        }

        synchronized (this) {
            try {
                JSObject credentials = new JSObject();
                credentials.put("deviceId", deviceId);
                credentials.put("deviceToken", deviceToken);
                storeCredentials(credentials.toString());
                call.resolve();
            } catch (Exception error) {
                call.reject("Device credentials could not be stored.");
            }
        }
    }

    @PluginMethod
    public void clearCredentials(PluginCall call) {
        synchronized (this) {
            try {
                clearStoredState();
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

    private void storeCredentials(String plaintext) throws Exception {
        Cipher cipher = Cipher.getInstance(CIPHER_TRANSFORMATION);
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateKey());
        byte[] ciphertext = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));

        boolean committed = preferences().edit()
            .putString(PREFERENCE_IV, Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
            .putString(PREFERENCE_PAYLOAD, Base64.encodeToString(ciphertext, Base64.NO_WRAP))
            .commit();
        if (!committed) throw new IllegalStateException("secure preferences commit failed");
    }

    private JSObject readCredentials() throws Exception {
        String encodedIv = preferences().getString(PREFERENCE_IV, null);
        String encodedPayload = preferences().getString(PREFERENCE_PAYLOAD, null);
        if (encodedIv == null && encodedPayload == null) return null;
        if (encodedIv == null || encodedPayload == null) throw new IllegalStateException("incomplete secure credential state");

        byte[] iv = Base64.decode(encodedIv, Base64.NO_WRAP);
        byte[] ciphertext = Base64.decode(encodedPayload, Base64.NO_WRAP);
        Cipher cipher = Cipher.getInstance(CIPHER_TRANSFORMATION);
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateKey(), new GCMParameterSpec(GCM_TAG_BITS, iv));
        String plaintext = new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
        JSObject credentials = JSObject.fromJSONObject(new JSONObject(plaintext));

        String deviceId = credentials.getString("deviceId");
        String deviceToken = credentials.getString("deviceToken");
        if (!isBoundedText(deviceId, MAX_DEVICE_ID_LENGTH) || !isBoundedText(deviceToken, MAX_DEVICE_TOKEN_LENGTH)) {
            throw new IllegalStateException("invalid secure credential payload");
        }
        return credentials;
    }

    private void clearStoredState() throws Exception {
        if (!preferences().edit().clear().commit()) {
            throw new IllegalStateException("secure preferences clear failed");
        }
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER);
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) keyStore.deleteEntry(KEY_ALIAS);
    }

    private void clearStoredStateBestEffort() {
        try {
            clearStoredState();
        } catch (Exception ignored) {
            // The caller still receives a generic failure; never expose credential details.
        }
    }
}
