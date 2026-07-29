package net.t4code.app;

import android.content.ClipData;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.content.pm.SigningInfo;
import android.net.Uri;
import android.os.Build;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.net.ssl.HttpsURLConnection;

/**
 * User-driven Android release checks. The WebView never supplies a URL: this
 * plugin validates T4's first-party manifest, downloads only its exact APK,
 * verifies the bytes and Android package identity, and then asks the system
 * package installer to prompt the user.
 */
@CapacitorPlugin(name = "T4Update")
public final class T4UpdatePlugin extends Plugin {
    private static final String MANIFEST_URL = "https://t4code.net/releases/latest.json";
    private static final String EXPECTED_PACKAGE_ID = "net.t4code.app";
    private static final String UPDATE_CACHE_DIRECTORY = "t4-updates";
    private static final String APK_MIME_TYPE = "application/vnd.android.package-archive";
    private static final String STATE_CHANGED_EVENT = "stateChanged";
    private static final int NETWORK_TIMEOUT_MS = 8_000;
    private static final int MAX_MANIFEST_BYTES = 64 * 1024;
    private static final long MAX_ASSET_BYTES = 1024L * 1024L * 1024L;
    private static final int MAX_ASSET_REDIRECTS = 4;
    private static final int MAX_ERROR_LENGTH = 240;
    private final T4UpdateStateMachine updateState = new T4UpdateStateMachine();
    private String latestVersion;
    private Long checkedAt;
    private String errorMessage;
    private String statusMessage;
    private ManifestRelease validatedRelease;
    private T4UpdateFileStore updateFiles;
    private File installerHandoff;
    private boolean installerWasPaused;
    private boolean recoveredHandoff;
    private volatile boolean destroyed;
    private final ExecutorService downloadExecutor = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "T4VerifiedUpdate");
        thread.setDaemon(true);
        return thread;
    });

    @Override
    public void load() {
        T4UpdateFileStore files = new T4UpdateFileStore(
            new File(getContext().getCacheDir(), UPDATE_CACHE_DIRECTORY)
        );
        File recovered = null;
        try {
            recovered = files.prepareOnStartup();
        } catch (Exception ignored) {
            // The foreground download path retries the sweep and reports a safe failure if storage is unavailable.
        }
        synchronized (this) {
            destroyed = false;
            updateFiles = files;
            installerHandoff = recovered;
            recoveredHandoff = recovered != null;
            installerWasPaused = false;
        }
    }

    @PluginMethod
    public void getState(PluginCall call) {
        synchronized (this) {
            call.resolve(statePayload());
        }
    }

    @PluginMethod
    public void checkForUpdate(PluginCall call) {
        JSObject checkingState;
        synchronized (this) {
            if (!updateState.beginCheck()) {
                call.resolve(statePayload());
                return;
            }
            statusMessage = "Checking the published Android release.";
            errorMessage = null;
            checkingState = statePayload();
        }
        notifyStateChanged(checkingState);
        try {
            ManifestRelease release = fetchRelease();
            String currentVersion = currentVersion();
            int comparison = T4UpdateVerifier.compareVersions(release.version, currentVersion);
            JSObject resultState;
            synchronized (this) {
                String resultPhase = comparison > 0 ? "available" : "current";
                if (!updateState.finishCheck(resultPhase)) {
                    call.resolve(statePayload());
                    return;
                }
                latestVersion = release.version;
                checkedAt = System.currentTimeMillis();
                errorMessage = null;
                statusMessage = null;
                if (comparison > 0) {
                    validatedRelease = release;
                } else {
                    validatedRelease = null;
                }
                resultState = statePayload();
            }
            call.resolve(resultState);
            notifyStateChanged(resultState);
        } catch (Exception ignored) {
            JSObject resultState;
            synchronized (this) {
                if (!updateState.finishCheck("error")) {
                    call.resolve(statePayload());
                    return;
                }
                latestVersion = null;
                checkedAt = System.currentTimeMillis();
                validatedRelease = null;
                statusMessage = null;
                errorMessage = boundedError(
                    "T4 Code could not verify the latest Android release. Check your connection and try again."
                );
                resultState = statePayload();
            }
            call.resolve(resultState);
            notifyStateChanged(resultState);
        }
    }

    @PluginMethod
    public void openUpdate(PluginCall call) {
        final ManifestRelease release;
        final JSObject startedState;
        synchronized (this) {
            release = validatedRelease;
            T4UpdateStateMachine.DownloadStart start = updateState.beginDownload(release != null);
            if (start != T4UpdateStateMachine.DownloadStart.STARTED) {
                if (
                    start == T4UpdateStateMachine.DownloadStart.BUSY ||
                    start == T4UpdateStateMachine.DownloadStart.HANDED_OFF
                ) {
                    call.resolve(statePayload());
                } else {
                    call.reject("Check for an available update first.");
                }
                return;
            }
            errorMessage = null;
            statusMessage = "Downloading the published APK for verification.";
            startedState = statePayload();
        }
        call.resolve(startedState);
        notifyStateChanged(startedState);

        try {
            downloadExecutor.execute(() -> {
                File packageFile = null;
                try {
                    if (destroyed) return;
                    packageFile = downloadVerifiedPackage(release);
                    verifyAndroidPackage(packageFile, release.version);
                    if (destroyed) {
                        discardUpdateFile(packageFile);
                        return;
                    }
                    File verifiedPackage = packageFile;
                    getBridge().executeOnMainThread(() -> openPackageInstaller(verifiedPackage));
                } catch (Exception ignored) {
                    discardUpdateFile(packageFile);
                    publishDownloadFailure();
                }
            });
        } catch (RuntimeException ignored) {
            publishDownloadFailure();
        }
    }

    @Override
    protected void handleOnPause() {
        synchronized (this) {
            if (installerHandoff != null && "installer".equals(updateState.phase())) {
                installerWasPaused = true;
            }
        }
    }

    @Override
    protected void handleOnResume() {
        final File completedHandoff;
        final JSObject resumedState;
        synchronized (this) {
            if (installerHandoff == null || (!recoveredHandoff && !installerWasPaused)) return;
            completedHandoff = installerHandoff;
            installerHandoff = null;
            recoveredHandoff = false;
            installerWasPaused = false;
            if ("installer".equals(updateState.phase())) {
                boolean canRetry = validatedRelease != null;
                updateState.installerReturned(canRetry);
                errorMessage = null;
                statusMessage = canRetry
                    ? "Android's installer closed. You can download the release again."
                    : null;
                resumedState = statePayload();
            } else {
                resumedState = null;
            }
        }
        finishInstallerHandoff(completedHandoff);
        if (resumedState != null) notifyStateChanged(resumedState);
    }

    @Override
    protected void handleOnDestroy() {
        destroyed = true;
        downloadExecutor.shutdownNow();
        T4UpdateFileStore files;
        synchronized (this) {
            files = updateFiles;
            validatedRelease = null;
            statusMessage = null;
            errorMessage = null;
            installerHandoff = null;
            recoveredHandoff = false;
            installerWasPaused = false;
            updateState.reset();
        }
        if (files != null) files.cleanupForDestroy();
    }

    private File downloadVerifiedPackage(ManifestRelease release) throws Exception {
        T4UpdateFileStore files = requireUpdateFiles();
        files.prepareForDownload();
        File partial = files.createPartial(release.version);

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
            return files.finalizeVerified(partial);
        } catch (Exception error) {
            files.discard(partial);
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
        PackageManager manager = getContext().getPackageManager();
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

    private void openPackageInstaller(File verifiedPackage) {
        synchronized (this) {
            if (destroyed || !"downloading".equals(updateState.phase())) {
                discardUpdateFile(verifiedPackage);
                return;
            }
        }
        final T4UpdateFileStore files;
        final File handoff;
        try {
            files = requireUpdateFiles();
            handoff = files.beginInstallerHandoff(verifiedPackage);
            synchronized (this) {
                installerHandoff = handoff;
                recoveredHandoff = false;
                installerWasPaused = false;
            }
            Uri contentUri = FileProvider.getUriForFile(
                getContext(),
                getContext().getPackageName() + ".fileprovider",
                handoff
            );
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(contentUri, APK_MIME_TYPE);
            intent.setClipData(ClipData.newRawUri("T4 Code update", contentUri));
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            getActivity().startActivity(intent);
        } catch (Exception ignored) {
            synchronized (this) {
                installerHandoff = null;
                recoveredHandoff = false;
                installerWasPaused = false;
            }
            discardUpdateFile(verifiedPackage);
            T4UpdateFileStore currentFiles;
            synchronized (this) {
                currentFiles = updateFiles;
            }
            if (currentFiles != null && currentFiles.activeHandoff() != null) {
                finishInstallerHandoff(currentFiles.activeHandoff());
            }
            publishDownloadFailure();
            return;
        }

        JSObject state;
        synchronized (this) {
            updateState.installerOpened();
            errorMessage = null;
            statusMessage = "The verified APK is open in Android's installer. Android will ask before replacing this installation.";
            state = statePayload();
        }
        notifyListeners(STATE_CHANGED_EVENT, state);
    }

    private T4UpdateFileStore requireUpdateFiles() {
        synchronized (this) {
            if (updateFiles == null) throw new IllegalStateException("Android update storage is unavailable");
            return updateFiles;
        }
    }

    private void discardUpdateFile(File file) {
        T4UpdateFileStore files;
        synchronized (this) {
            files = updateFiles;
        }
        if (files != null) files.discard(file);
        else if (file != null) file.delete();
    }

    private void finishInstallerHandoff(File handoff) {
        T4UpdateFileStore files;
        synchronized (this) {
            files = updateFiles;
        }
        if (files == null || handoff == null) return;
        try {
            files.finishInstallerHandoff(handoff);
        } catch (Exception ignored) {
            // The next startup or foreground download retries this bounded one-file cleanup.
        }
    }

    private void publishDownloadFailure() {
        JSObject state;
        synchronized (this) {
            if (!"downloading".equals(updateState.phase())) return;
            updateState.downloadFailed();
            validatedRelease = null;
            statusMessage = null;
            errorMessage = boundedError(
                "T4 Code could not verify and open the Android update. Your current installation is unchanged."
            );
            state = statePayload();
        }
        notifyStateChanged(state);
    }

    private void notifyStateChanged(JSObject state) {
        getBridge().executeOnMainThread(() -> notifyListeners(STATE_CHANGED_EVENT, state));
    }

    private JSObject statePayload() {
        JSObject result = new JSObject();
        result.put("currentVersion", currentVersion());
        result.put("phase", updateState.phase());
        result.put("revision", updateState.revision());
        if (latestVersion != null) result.put("latestVersion", latestVersion);
        if (checkedAt != null) result.put("checkedAt", checkedAt);
        if (errorMessage != null) result.put("error", errorMessage);
        if (statusMessage != null) result.put("message", statusMessage);
        return result;
    }

    private String currentVersion() {
        if (!EXPECTED_PACKAGE_ID.equals(BuildConfig.APPLICATION_ID)) {
            throw new IllegalStateException("Android application identity is invalid");
        }
        String version = BuildConfig.VERSION_NAME;
        if (!T4UpdateVerifier.isValidVersion(version)) {
            throw new IllegalStateException("Android application version is invalid");
        }
        return version;
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
                throw new IllegalStateException("update manifest response was not successful");
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
        if (requireJsonInteger(manifest, "schemaVersion") != 1 || !"stable".equals(requireJsonString(manifest, "channel"))) {
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
        return (String) value;
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

    private String boundedError(String message) {
        StringBuilder output = new StringBuilder();
        for (int index = 0; index < message.length() && output.length() < MAX_ERROR_LENGTH; index += 1) {
            char character = message.charAt(index);
            output.append(character <= 0x1f || character == 0x7f ? ' ' : character);
        }
        return output.toString();
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
