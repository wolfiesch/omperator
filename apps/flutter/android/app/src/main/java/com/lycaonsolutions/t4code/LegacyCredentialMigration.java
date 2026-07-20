package com.lycaonsolutions.t4code;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

final class LegacyCredentialMigration {
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

    private final Context context;

    LegacyCredentialMigration(Context context) {
        this.context = context.getApplicationContext();
    }

    synchronized Map<String, String> discover(List<?> hostKeys, boolean includeUnkeyed)
        throws Exception {
        SharedPreferences preferences = preferences();
        Set<String> visited = new HashSet<>();
        for (Object value : hostKeys) {
            if (!(value instanceof String) || !isBoundedText((String) value, MAX_HOST_KEY_LENGTH)) {
                throw new IllegalArgumentException("Invalid host key.");
            }
            String hostKey = (String) value;
            if (!visited.add(hostKey)) continue;

            String suffix = preferenceSuffix(hostKey);
            String ivKey = PREFERENCE_IV_PREFIX + suffix;
            String payloadKey = PREFERENCE_PAYLOAD_PREFIX + suffix;
            String encodedIv = preferences.getString(ivKey, null);
            String encodedPayload = preferences.getString(payloadKey, null);
            if (encodedIv != null || encodedPayload != null) {
                requireComplete(encodedIv, encodedPayload);
                return decrypt(
                    encodedIv,
                    encodedPayload,
                    hostKey,
                    sourceSelector("keyed", suffix, encodedIv, encodedPayload)
                );
            }
        }

        if (!includeUnkeyed) return null;
        String encodedIv = preferences.getString(PREFERENCE_IV, null);
        String encodedPayload = preferences.getString(PREFERENCE_PAYLOAD, null);
        if (encodedIv == null && encodedPayload == null) return null;
        requireComplete(encodedIv, encodedPayload);
        return decrypt(
            encodedIv,
            encodedPayload,
            null,
            sourceSelector("unkeyed", "", encodedIv, encodedPayload)
        );
    }

    synchronized void clear(String source) throws Exception {
        if (source == null) throw new IllegalArgumentException("Invalid legacy source.");
        String[] parts = source.split("\\.", -1);
        final String ivKey;
        final String payloadKey;
        final String expectedFingerprint;
        if (parts.length == 3 && "keyed".equals(parts[0]) && isHexDigest(parts[1])) {
            ivKey = PREFERENCE_IV_PREFIX + parts[1];
            payloadKey = PREFERENCE_PAYLOAD_PREFIX + parts[1];
            expectedFingerprint = parts[2];
        } else if (parts.length == 2 && "unkeyed".equals(parts[0])) {
            ivKey = PREFERENCE_IV;
            payloadKey = PREFERENCE_PAYLOAD;
            expectedFingerprint = parts[1];
        } else {
            throw new IllegalArgumentException("Invalid legacy source.");
        }
        if (!isHexDigest(expectedFingerprint)) {
            throw new IllegalArgumentException("Invalid legacy source.");
        }

        SharedPreferences preferences = preferences();
        String encodedIv = preferences.getString(ivKey, null);
        String encodedPayload = preferences.getString(payloadKey, null);
        requireComplete(encodedIv, encodedPayload);
        String actualFingerprint = payloadFingerprint(encodedIv, encodedPayload);
        if (!MessageDigest.isEqual(
            expectedFingerprint.getBytes(StandardCharsets.US_ASCII),
            actualFingerprint.getBytes(StandardCharsets.US_ASCII)
        )) {
            throw new IllegalStateException("Legacy source changed.");
        }
        if (!preferences.edit().remove(ivKey).remove(payloadKey).commit()) {
            throw new IllegalStateException("Legacy source could not be cleared.");
        }
    }

    private SharedPreferences preferences() {
        return context.getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE);
    }

    private Map<String, String> decrypt(
        String encodedIv,
        String encodedPayload,
        String hostKey,
        String source
    ) throws Exception {
        byte[] iv = Base64.decode(encodedIv, Base64.NO_WRAP);
        byte[] ciphertext = Base64.decode(encodedPayload, Base64.NO_WRAP);
        Cipher cipher = Cipher.getInstance(CIPHER_TRANSFORMATION);
        cipher.init(Cipher.DECRYPT_MODE, existingKey(), new GCMParameterSpec(GCM_TAG_BITS, iv));
        if (hostKey != null) cipher.updateAAD(hostKey.getBytes(StandardCharsets.UTF_8));
        String plaintext = new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
        JSONObject credentials = new JSONObject(plaintext);
        String deviceId = credentials.getString("deviceId");
        String deviceToken = credentials.getString("deviceToken");
        if (!isBoundedText(deviceId, MAX_DEVICE_ID_LENGTH)
            || !isBoundedText(deviceToken, MAX_DEVICE_TOKEN_LENGTH)) {
            throw new IllegalStateException("Invalid legacy credential payload.");
        }

        Map<String, String> result = new HashMap<>();
        result.put("deviceId", deviceId);
        result.put("deviceToken", deviceToken);
        result.put("source", source);
        return result;
    }

    private SecretKey existingKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER);
        keyStore.load(null);
        if (!keyStore.containsAlias(KEY_ALIAS)) {
            throw new IllegalStateException("Legacy key is unavailable.");
        }
        return (SecretKey) keyStore.getKey(KEY_ALIAS, null);
    }

    private static void requireComplete(String encodedIv, String encodedPayload) {
        if (encodedIv == null || encodedPayload == null) {
            throw new IllegalStateException("Incomplete legacy credential state.");
        }
    }

    private static String preferenceSuffix(String hostKey) throws Exception {
        return hex(
            MessageDigest.getInstance("SHA-256")
                .digest(hostKey.getBytes(StandardCharsets.UTF_8))
        );
    }

    private static String sourceSelector(
        String kind,
        String suffix,
        String encodedIv,
        String encodedPayload
    ) throws Exception {
        String fingerprint = payloadFingerprint(encodedIv, encodedPayload);
        return "keyed".equals(kind)
            ? kind + "." + suffix + "." + fingerprint
            : kind + "." + fingerprint;
    }

    private static String payloadFingerprint(String encodedIv, String encodedPayload)
        throws Exception {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        digest.update(encodedIv.getBytes(StandardCharsets.UTF_8));
        digest.update((byte) 0);
        digest.update(encodedPayload.getBytes(StandardCharsets.UTF_8));
        return hex(digest.digest());
    }

    private static String hex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) {
            result.append(HEX_DIGITS[(value >>> 4) & 0x0f]);
            result.append(HEX_DIGITS[value & 0x0f]);
        }
        return result.toString();
    }

    private static boolean isHexDigest(String value) {
        if (value.length() != 64) return false;
        for (int index = 0; index < value.length(); index += 1) {
            char character = value.charAt(index);
            if ((character < '0' || character > '9')
                && (character < 'a' || character > 'f')) return false;
        }
        return true;
    }

    private static boolean isBoundedText(String value, int maxLength) {
        if (value == null || value.isEmpty() || value.length() > maxLength) return false;
        for (int index = 0; index < value.length(); index += 1) {
            char character = value.charAt(index);
            if (character <= 0x1f || character == 0x7f) return false;
        }
        return true;
    }
}
