package com.lycaonsolutions.t4code;

import android.app.Activity;
import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.net.Uri;
import android.os.Build;

import androidx.core.content.FileProvider;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

import javax.net.ssl.HttpsURLConnection;

import io.flutter.plugin.common.MethodCall;
import io.flutter.plugin.common.MethodChannel;

/**
 * User-driven Android release updates for Flutter's platform lifecycle channel.
 * The Dart layer supplies no URLs or package data: native code verifies T4's
 * exact first-party manifest, APK bytes, package identity, version, and signer
 * before a separate user action may open Android's installer.
 */
final class T4UpdatePlugin {
    static final String CHANNEL_NAME = "com.lycaonsolutions.t4code/platform_lifecycle";

    private static final String MANIFEST_URL = "https://t4code.net/releases/latest.json";
    private static final String EXPECTED_PACKAGE_ID = "com.lycaonsolutions.t4code";
    private static final String UPDATE_CACHE_DIRECTORY = "t4-updates";
    private static final String APK_MIME_TYPE = "application/vnd.android.package-archive";
    private static final int NETWORK_TIMEOUT_MS = 8_000;
    private static final int MAX_MANIFEST_BYTES = 64 * 1024;
    private static final long MAX_ASSET_BYTES = 1024L * 1024L * 1024L;
    private static final int MAX_ASSET_REDIRECTS = 4;
    private static final int MAX_TEXT_LENGTH = 512;

    private final Activity activity;
    private final T4UpdateStateMachine updateState = new T4UpdateStateMachine();
    private final T4UpdateFileStore updateFiles;
    private final ExecutorService executor = new ThreadPoolExecutor(
        1,
        1,
        0L,
        TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<>(8),
        runnable -> {
            Thread thread = new Thread(runnable, "T4VerifiedUpdate");
            thread.setDaemon(true);
            return thread;
        },
        new ThreadPoolExecutor.AbortPolicy()
    );

    private String latestVersion;
    private Long checkedAt;
    private String errorMessage;
    private String statusMessage;
    private ManifestRelease validatedRelease;
    private File verifiedPackage;
    private File installerHandoff;
    private boolean installerWasPaused;
    private boolean recoveredHandoff;
    private volatile boolean destroyed;

    T4UpdatePlugin(Activity activity) {
        this.activity = activity;
        updateFiles = new T4UpdateFileStore(
            new File(activity.getCacheDir(), UPDATE_CACHE_DIRECTORY)
        );
        submitInternal(() -> {
            try {
                File recovered = updateFiles.prepareOnStartup();
                synchronized (this) {
                    if (destroyed) return;
                    installerHandoff = recovered;
                    recoveredHandoff = recovered != null;
                }
            } catch (IOException ignored) {
                // The foreground download path retries the private cache sweep.
            }
        });
    }

    void handle(MethodCall call, MethodChannel.Result result) {
        if (call.arguments != null) {
            sendError(result, "invalid_state", "Android update methods do not accept arguments.");
            return;
        }
        switch (call.method) {
            case "update.getState":
                submit(result, () -> completeSuccess(result, statePayload()));
                break;
            case "update.check":
                submit(result, () -> checkForUpdate(result));
                break;
            case "update.download":
                submit(result, () -> downloadUpdate(result));
                break;
            case "update.install":
                submit(result, () -> installUpdate(result));
                break;
            default:
                result.notImplemented();
                break;
        }
    }

    void onPause() {
        synchronized (this) {
            if (installerHandoff != null && "installer".equals(updateState.phase())) {
                installerWasPaused = true;
            }
        }
    }

    void onResume() {
        submitInternal(() -> {
            final File completedHandoff;
            synchronized (this) {
                if (installerHandoff == null || (!recoveredHandoff && !installerWasPaused)) return;
                completedHandoff = installerHandoff;
                installerHandoff = null;
                recoveredHandoff = false;
                installerWasPaused = false;
                verifiedPackage = null;
                if ("installer".equals(updateState.phase())) {
                    boolean canRetry = validatedRelease != null;
                    updateState.installerReturned(canRetry);
                    errorMessage = null;
                    statusMessage = canRetry
                        ? "Android's installer closed. Download the release again to retry."
                        : null;
                }
            }
            finishInstallerHandoff(completedHandoff);
        });
    }

    void destroy() {
        destroyed = true;
        executor.shutdownNow();
        File unhandedPackage;
        synchronized (this) {
            unhandedPackage = verifiedPackage;
            verifiedPackage = null;
            validatedRelease = null;
            statusMessage = null;
            errorMessage = null;
            updateState.reset();
        }
        updateFiles.discard(unhandedPackage);
        updateFiles.cleanupForDestroy();
    }

    private void checkForUpdate(MethodChannel.Result result) {
        File stalePackage;
        synchronized (this) {
            if (!updateState.beginCheck()) {
                completeSuccess(result, statePayload());
                return;
            }
            stalePackage = verifiedPackage;
            verifiedPackage = null;
            statusMessage = "Checking the published Android release.";
            errorMessage = null;
        }
        updateFiles.discard(stalePackage);

        try {
            ManifestRelease release = fetchRelease();
            String currentVersion = currentVersion();
            int comparison = T4UpdateVerifier.compareVersions(release.version, currentVersion);
            Map<String, Object> state;
            synchronized (this) {
                if (!updateState.finishCheck(comparison > 0 ? "available" : "current")) {
                    completeSuccess(result, statePayload());
                    return;
                }
                latestVersion = release.version;
                checkedAt = System.currentTimeMillis();
                errorMessage = null;
                statusMessage = null;
                validatedRelease = comparison > 0 ? release : null;
                state = statePayload();
            }
            completeSuccess(result, state);
        } catch (IOException error) {
            finishCheckFailure(
                result,
                "T4 Code could not reach the published Android release. Check your connection and try again."
            );
        } catch (Exception error) {
            finishCheckFailure(
                result,
                "T4 Code could not validate the published Android release manifest."
            );
        }
    }

    private void finishCheckFailure(MethodChannel.Result result, String message) {
        Map<String, Object> state;
        synchronized (this) {
            if (!updateState.finishCheck("error")) {
                completeSuccess(result, statePayload());
                return;
            }
            latestVersion = null;
            checkedAt = System.currentTimeMillis();
            validatedRelease = null;
            statusMessage = null;
            errorMessage = boundedText(message);
            state = statePayload();
        }
        completeSuccess(result, state);
    }

    private void downloadUpdate(MethodChannel.Result result) {
        final ManifestRelease release;
        synchronized (this) {
            release = validatedRelease;
            if (updateState.beginDownload(release != null) != T4UpdateStateMachine.DownloadStart.STARTED) {
                completeSuccess(result, statePayload());
                return;
            }
            errorMessage = null;
            statusMessage = "Downloading and verifying the published Android APK.";
        }

        File packageFile = null;
        try {
            if (destroyed) throw new IllegalStateException("activity was destroyed");
            packageFile = downloadVerifiedPackage(release);
            verifyAndroidPackage(packageFile, release.version);
            if (destroyed) throw new IllegalStateException("activity was destroyed");
            Map<String, Object> state;
            synchronized (this) {
                verifiedPackage = packageFile;
                updateState.downloadSucceeded();
                errorMessage = null;
                statusMessage = "The Android update is verified and ready for installation.";
                state = statePayload();
            }
            completeSuccess(result, state);
        } catch (Exception error) {
            updateFiles.discard(packageFile);
            Map<String, Object> state;
            synchronized (this) {
                if ("downloading".equals(updateState.phase())) updateState.downloadFailed();
                verifiedPackage = null;
                validatedRelease = null;
                statusMessage = null;
                errorMessage = boundedText(
                    "T4 Code could not verify the Android update. Your current installation is unchanged."
                );
                state = statePayload();
            }
            completeSuccess(result, state);
        }
    }

    private void installUpdate(MethodChannel.Result result) {
        final File packageFile;
        synchronized (this) {
            packageFile = verifiedPackage;
            if (packageFile == null || !packageFile.isFile() || !"available".equals(updateState.phase())) {
                sendError(result, "invalid_state", "Download and verify an available update first.");
                return;
            }
        }

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
            !activity.getPackageManager().canRequestPackageInstalls()) {
            sendError(
                result,
                "installer_unavailable",
                "Android has not allowed T4 Code to request package installation."
            );
            return;
        }

        final File handoff;
        final Uri contentUri;
        try {
            handoff = updateFiles.beginInstallerHandoff(packageFile);
            contentUri = FileProvider.getUriForFile(
                activity,
                activity.getPackageName() + ".fileprovider",
                handoff
            );
            synchronized (this) {
                installerHandoff = handoff;
                recoveredHandoff = false;
                installerWasPaused = false;
                verifiedPackage = null;
            }
        } catch (Exception error) {
            updateFiles.discard(packageFile);
            synchronized (this) {
                verifiedPackage = null;
            }
            sendError(result, "installer_unavailable", "Android's package installer is unavailable.");
            return;
        }

        CountDownLatch installerCompleted = new CountDownLatch(1);
        activity.runOnUiThread(() -> {
            try {
                if (destroyed) {
                    failInstallerHandoff(result, handoff);
                    return;
                }
                Intent intent = new Intent(Intent.ACTION_VIEW);
                intent.setDataAndType(contentUri, APK_MIME_TYPE);
                intent.setClipData(ClipData.newRawUri("T4 Code update", contentUri));
                intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                activity.startActivity(intent);
                Map<String, Object> state;
                synchronized (this) {
                    updateState.installerOpened();
                    errorMessage = null;
                    statusMessage = "The verified APK is open in Android's installer.";
                    state = statePayload();
                }
                result.success(state);
            } catch (Exception error) {
                failInstallerHandoff(result, handoff);
            } finally {
                installerCompleted.countDown();
            }
        });
        try {
            installerCompleted.await();
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        }
    }

    private void failInstallerHandoff(MethodChannel.Result result, File handoff) {
        synchronized (this) {
            installerHandoff = null;
            recoveredHandoff = false;
            installerWasPaused = false;
        }
        submitInternal(() -> finishInstallerHandoff(handoff));
        result.error(
            "installer_unavailable",
            boundedText("Android's package installer is unavailable."),
            null
        );
    }

    private File downloadVerifiedPackage(ManifestRelease release) throws Exception {
        updateFiles.prepareForDownload();
        File partial = updateFiles.createPartial(release.version);
        HttpsURLConnection connection = null;
        try {
            connection = openAssetConnection(release.apkUrl);
            long responseSize = connection.getContentLengthLong();
            if (responseSize >= 0 && responseSize != release.apkSize) {
                throw new IllegalStateException("release response size does not match its manifest");
            }
            try (
                InputStream input = new BufferedInputStream(connection.getInputStream());
                FileOutputStream fileOutput = new FileOutputStream(partial, false);
                BufferedOutputStream output = new BufferedOutputStream(fileOutput)
            ) {
                T4UpdateVerifier.copyExact(input, output, release.apkSize, release.apkSha256);
                fileOutput.getFD().sync();
            }
            return updateFiles.finalizeVerified(partial);
        } catch (Exception error) {
            updateFiles.discard(partial);
            throw error;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private HttpsURLConnection openAssetConnection(String validatedUrl) throws Exception {
        URL current = new URL(validatedUrl);
        for (int redirects = 0; redirects <= MAX_ASSET_REDIRECTS; redirects += 1) {
            T4UpdateVerifier.requireAllowedAssetUrl(current, redirects == 0);
            if (redirects == 0 && !validatedUrl.equals(current.toString())) {
                throw new IllegalStateException("release asset URL changed before download");
            }
            HttpsURLConnection connection = (HttpsURLConnection) current.openConnection();
            connection.setConnectTimeout(NETWORK_TIMEOUT_MS);
            connection.setReadTimeout(NETWORK_TIMEOUT_MS);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestMethod("GET");
            connection.setRequestProperty("Accept", APK_MIME_TYPE);
            connection.setRequestProperty("Accept-Encoding", "identity");
            connection.setUseCaches(false);
            int status = connection.getResponseCode();
            if (status == HttpsURLConnection.HTTP_OK) return connection;
            if (!T4UpdateVerifier.isRedirectStatus(status) || redirects == MAX_ASSET_REDIRECTS) {
                connection.disconnect();
                throw new IllegalStateException("release asset response was not successful");
            }
            String location = connection.getHeaderField("Location");
            connection.disconnect();
            if (location == null || location.isEmpty() || location.length() > 8192) {
                throw new IllegalStateException("release asset redirect is invalid");
            }
            current = new URL(current, location);
        }
        throw new IllegalStateException("release asset redirect limit exceeded");
    }

    private void verifyAndroidPackage(File packageFile, String expectedVersion) throws Exception {
        PackageManager manager = activity.getPackageManager();
        PackageInfo candidate = archivePackageInfo(manager, packageFile);
        if (candidate == null || !EXPECTED_PACKAGE_ID.equals(candidate.packageName)) {
            throw new IllegalStateException("update package identity does not match T4 Code");
        }
        if (!expectedVersion.equals(candidate.versionName)) {
            throw new IllegalStateException("update package version does not match its manifest");
        }
        PackageInfo installed = installedPackageInfo(manager);
        if (!EXPECTED_PACKAGE_ID.equals(installed.packageName)) {
            throw new IllegalStateException("installed package identity does not match T4 Code");
        }
        boolean trustedSigner;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            SigningEvidence installedSigning = signingEvidence(installed);
            SigningEvidence candidateSigning = signingEvidence(candidate);
            trustedSigner = T4UpdateVerifier.isTrustedSignerTransition(
                installedSigning.current,
                installedSigning.history,
                installedSigning.multiple,
                candidateSigning.current,
                candidateSigning.history,
                candidateSigning.multiple
            );
        } else {
            trustedSigner = T4UpdateVerifier.sameSignerSet(legacySigners(installed), legacySigners(candidate));
        }
        if (!trustedSigner) {
            throw new IllegalStateException("update package signer does not match this installation");
        }
    }

    @SuppressWarnings("deprecation")
    private PackageInfo installedPackageInfo(PackageManager manager) throws Exception {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return manager.getPackageInfo(
                EXPECTED_PACKAGE_ID,
                PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES)
            );
        }
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            ? PackageManager.GET_SIGNING_CERTIFICATES
            : PackageManager.GET_SIGNATURES;
        return manager.getPackageInfo(EXPECTED_PACKAGE_ID, flags);
    }

    @SuppressWarnings("deprecation")
    private PackageInfo archivePackageInfo(PackageManager manager, File packageFile) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            return manager.getPackageArchiveInfo(
                packageFile.getAbsolutePath(),
                PackageManager.PackageInfoFlags.of(PackageManager.GET_SIGNING_CERTIFICATES)
            );
        }
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
            ? PackageManager.GET_SIGNING_CERTIFICATES
            : PackageManager.GET_SIGNATURES;
        return manager.getPackageArchiveInfo(packageFile.getAbsolutePath(), flags);
    }

    @android.annotation.TargetApi(Build.VERSION_CODES.P)
    private SigningEvidence signingEvidence(PackageInfo packageInfo) {
        SigningInfo signingInfo = packageInfo.signingInfo;
        if (signingInfo == null) return new SigningEvidence(new ArrayList<>(), new ArrayList<>(), false);
        boolean multiple = signingInfo.hasMultipleSigners();
        List<byte[]> current = signatureBytes(signingInfo.getApkContentsSigners());
        List<byte[]> history = multiple ? new ArrayList<>() : signatureBytes(signingInfo.getSigningCertificateHistory());
        return new SigningEvidence(current, history, multiple);
    }

    @SuppressWarnings("deprecation")
    private List<byte[]> legacySigners(PackageInfo packageInfo) {
        return signatureBytes(packageInfo.signatures);
    }

    private List<byte[]> signatureBytes(Signature[] signatures) {
        if (signatures == null) return new ArrayList<>();
        List<byte[]> result = new ArrayList<>(signatures.length);
        for (Signature signature : signatures) result.add(signature.toByteArray());
        return result;
    }

    @SuppressWarnings("deprecation")
    private String currentVersion() {
        String packageName = activity.getPackageName();
        if (!EXPECTED_PACKAGE_ID.equals(packageName)) {
            throw new IllegalStateException("Android application identity is invalid");
        }
        try {
            PackageInfo packageInfo;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                packageInfo = activity.getPackageManager().getPackageInfo(
                    packageName,
                    PackageManager.PackageInfoFlags.of(0)
                );
            } else {
                packageInfo = activity.getPackageManager().getPackageInfo(packageName, 0);
            }
            String version = packageInfo.versionName;
            if (!T4UpdateVerifier.isValidVersion(version)) {
                throw new IllegalStateException("Android application version is invalid");
            }
            return version;
        } catch (PackageManager.NameNotFoundException error) {
            throw new IllegalStateException("Android application identity is unavailable", error);
        }
    }

    private ManifestRelease fetchRelease() throws Exception {
        HttpsURLConnection connection = (HttpsURLConnection) new URL(MANIFEST_URL).openConnection();
        connection.setConnectTimeout(NETWORK_TIMEOUT_MS);
        connection.setReadTimeout(NETWORK_TIMEOUT_MS);
        connection.setInstanceFollowRedirects(false);
        connection.setRequestMethod("GET");
        connection.setRequestProperty("Accept", "application/json");
        connection.setUseCaches(false);
        try {
            if (connection.getResponseCode() != HttpsURLConnection.HTTP_OK) {
                throw new IOException("update manifest response was not successful");
            }
            long declaredLength = connection.getContentLengthLong();
            if (declaredLength > MAX_MANIFEST_BYTES) {
                throw new IllegalStateException("update manifest is too large");
            }
            byte[] bytes;
            try (InputStream input = connection.getInputStream()) {
                bytes = readBounded(input);
            }
            return parseManifest(new JSONObject(new String(bytes, StandardCharsets.UTF_8)));
        } finally {
            connection.disconnect();
        }
    }

    private byte[] readBounded(InputStream input) throws Exception {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8 * 1024];
        int count;
        while ((count = input.read(buffer)) != -1) {
            if (output.size() + count > MAX_MANIFEST_BYTES) {
                throw new IllegalStateException("update manifest is too large");
            }
            output.write(buffer, 0, count);
        }
        return output.toByteArray();
    }

    private ManifestRelease parseManifest(JSONObject manifest) throws Exception {
        requireExactKeys(
            manifest,
            "schemaVersion",
            "channel",
            "version",
            "tag",
            "publishedAt",
            "releaseUrl",
            "assets"
        );
        if (requireJsonInteger(manifest, "schemaVersion") != 1 ||
            !"stable".equals(requireJsonString(manifest, "channel"))) {
            throw new IllegalStateException("unsupported update manifest");
        }

        String version = requireJsonString(manifest, "version");
        T4UpdateVerifier.requireManifestReleaseIdentity(
            version,
            requireJsonString(manifest, "tag"),
            requireJsonString(manifest, "releaseUrl"),
            requireJsonString(manifest, "publishedAt")
        );

        Object assetsValue = manifest.get("assets");
        if (!(assetsValue instanceof JSONArray)) throw new IllegalStateException("release assets must be an array");
        JSONArray assets = (JSONArray) assetsValue;
        if (assets.length() != 5) throw new IllegalStateException("invalid release asset count");
        Set<String> identities = new HashSet<>();
        String apkUrl = null;
        Long apkSize = null;
        String apkSha256 = null;
        for (int index = 0; index < assets.length(); index += 1) {
            JSONObject asset = assets.getJSONObject(index);
            requireExactKeys(asset, "platform", "kind", "arch", "name", "url", "size", "sha256");
            String platform = requireJsonString(asset, "platform");
            String kind = requireJsonString(asset, "kind");
            String arch = requireJsonString(asset, "arch");
            String name = requireJsonString(asset, "name");
            String url = requireJsonString(asset, "url");
            long size = requireJsonInteger(asset, "size");
            String sha256 = requireJsonString(asset, "sha256");
            String identity = T4UpdateVerifier.requireManifestAsset(
                version,
                platform,
                kind,
                arch,
                name,
                url,
                size,
                sha256,
                MAX_ASSET_BYTES
            );
            if (!identities.add(identity)) throw new IllegalStateException("duplicate release asset");
            if ("android:apk:universal".equals(identity)) {
                apkUrl = url;
                apkSize = size;
                apkSha256 = sha256;
            }
        }
        if (identities.size() != 5 || apkUrl == null || apkSize == null || apkSha256 == null) {
            throw new IllegalStateException("Android release asset is missing");
        }
        return new ManifestRelease(version, apkUrl, apkSize, apkSha256);
    }

    private String requireJsonString(JSONObject object, String key) throws Exception {
        Object value = object.get(key);
        if (!(value instanceof String)) throw new IllegalStateException(key + " must be a string");
        String string = (String) value;
        if (string.length() > 8192) throw new IllegalStateException(key + " is too long");
        return string;
    }

    private long requireJsonInteger(JSONObject object, String key) throws Exception {
        Object value = object.get(key);
        if (!(value instanceof Number)) throw new IllegalStateException(key + " must be an integer");
        Number number = (Number) value;
        long integer = number.longValue();
        double numeric = number.doubleValue();
        if (Double.isNaN(numeric) || Double.isInfinite(numeric) || numeric != (double) integer) {
            throw new IllegalStateException(key + " must be an integer");
        }
        return integer;
    }

    private void requireExactKeys(JSONObject object, String... expected) {
        Set<String> keys = new HashSet<>();
        Iterator<String> iterator = object.keys();
        while (iterator.hasNext()) keys.add(iterator.next());
        Set<String> allowed = new HashSet<>();
        for (String key : expected) allowed.add(key);
        if (!keys.equals(allowed)) throw new IllegalStateException("unexpected update manifest fields");
    }

    private synchronized Map<String, Object> statePayload() {
        Map<String, Object> result = new LinkedHashMap<>(7);
        result.put("currentVersion", currentVersion());
        result.put("phase", updateState.phase());
        result.put("revision", updateState.revision());
        if (latestVersion != null) result.put("latestVersion", latestVersion);
        if (checkedAt != null) result.put("checkedAt", checkedAt);
        if (errorMessage != null) result.put("error", boundedText(errorMessage));
        if (statusMessage != null) result.put("message", boundedText(statusMessage));
        return result;
    }

    private String boundedText(String message) {
        if (message == null) return "";
        StringBuilder output = new StringBuilder(Math.min(message.length(), MAX_TEXT_LENGTH));
        for (int index = 0; index < message.length() && output.length() < MAX_TEXT_LENGTH; index += 1) {
            char character = message.charAt(index);
            output.append(character <= 0x1f || character == 0x7f ? ' ' : character);
        }
        return output.toString();
    }

    private void submit(MethodChannel.Result result, Runnable operation) {
        try {
            executor.execute(() -> {
                try {
                    operation.run();
                } catch (Exception error) {
                    sendError(result, "invalid_state", "Android update state is unavailable.");
                }
            });
        } catch (RejectedExecutionException error) {
            sendError(result, "invalid_state", "Android update operations are unavailable.");
        }
    }

    private void submitInternal(Runnable operation) {
        try {
            executor.execute(operation);
        } catch (RejectedExecutionException ignored) {
            // Activity teardown owns final private-cache cleanup.
        }
    }

    private void completeSuccess(MethodChannel.Result result, Map<String, Object> value) {
        activity.runOnUiThread(() -> result.success(value));
    }

    private void sendError(MethodChannel.Result result, String code, String message) {
        activity.runOnUiThread(() -> result.error(code, boundedText(message), null));
    }

    private void finishInstallerHandoff(File handoff) {
        if (handoff == null) return;
        try {
            updateFiles.finishInstallerHandoff(handoff);
        } catch (IOException ignored) {
            // Startup and pre-download sweeps retry this bounded one-file cleanup.
        }
    }

    private static final class ManifestRelease {
        private final String version;
        private final String apkUrl;
        private final long apkSize;
        private final String apkSha256;

        private ManifestRelease(String version, String apkUrl, long apkSize, String apkSha256) {
            this.version = version;
            this.apkUrl = apkUrl;
            this.apkSize = apkSize;
            this.apkSha256 = apkSha256;
        }
    }

    private static final class SigningEvidence {
        private final List<byte[]> current;
        private final List<byte[]> history;
        private final boolean multiple;

        private SigningEvidence(List<byte[]> current, List<byte[]> history, boolean multiple) {
            this.current = current;
            this.history = history;
            this.multiple = multiple;
        }
    }
}
