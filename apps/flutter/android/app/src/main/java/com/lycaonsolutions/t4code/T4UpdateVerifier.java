package com.lycaonsolutions.t4code;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/** Pure-Java verification primitives shared by the Android updater and JVM tests. */
final class T4UpdateVerifier {
    private static final int COPY_BUFFER_BYTES = 64 * 1024;
    private static final String RELEASE_DOWNLOAD_ROOT = "https://github.com/LycaonLLC/t4-code/releases/download/";
    private static final String RELEASE_PAGE_ROOT = "https://github.com/LycaonLLC/t4-code/releases/tag/";
    private static final Pattern VERSION_PATTERN = Pattern.compile(
        "^(?:0|[1-9][0-9]{0,5})\\.(?:0|[1-9][0-9]{0,5})\\.(?:0|[1-9][0-9]{0,5})$"
    );
    private static final Pattern SHA256_PATTERN = Pattern.compile("^[0-9a-f]{64}$");
    private static final Pattern PUBLISHED_AT_PATTERN = Pattern.compile(
        "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]{1,9})?Z$"
    );

    private T4UpdateVerifier() {}

    static void copyExact(
        InputStream input,
        OutputStream output,
        long expectedSize,
        String expectedSha256
    ) throws Exception {
        if (expectedSize <= 0) throw new IllegalArgumentException("expected size must be positive");
        if (!isValidSha256(expectedSha256)) {
            throw new IllegalArgumentException("expected SHA-256 is invalid");
        }

        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        byte[] buffer = new byte[COPY_BUFFER_BYTES];
        long total = 0;
        int count;
        while ((count = input.read(buffer)) != -1) {
            if (count == 0) continue;
            if (count > expectedSize - total) {
                throw new IllegalStateException("downloaded package exceeds its declared size");
            }
            output.write(buffer, 0, count);
            digest.update(buffer, 0, count);
            total += count;
        }
        if (total != expectedSize) {
            throw new IllegalStateException("downloaded package size does not match its manifest");
        }
        String actualSha256 = lowercaseHex(digest.digest());
        if (!MessageDigest.isEqual(
            expectedSha256.getBytes(java.nio.charset.StandardCharsets.US_ASCII),
            actualSha256.getBytes(java.nio.charset.StandardCharsets.US_ASCII)
        )) {
            throw new IllegalStateException("downloaded package digest does not match its manifest");
        }
        output.flush();
    }

    static boolean sameSignerSet(List<byte[]> installed, List<byte[]> candidate) throws Exception {
        if (installed == null || candidate == null || installed.isEmpty() || candidate.isEmpty()) return false;
        Set<String> installedFingerprints = signerFingerprints(installed);
        Set<String> candidateFingerprints = signerFingerprints(candidate);
        return installedFingerprints.size() == installed.size() &&
            candidateFingerprints.size() == candidate.size() &&
            installedFingerprints.equals(candidateFingerprints);
    }

    /**
     * Accepts the same signer, or a forward single-signer rotation whose
     * PackageManager-verified candidate history contains the installed current
     * signer. Multi-signer packages cannot rotate and must match exactly.
     */
    static boolean isTrustedSignerTransition(
        List<byte[]> installedCurrent,
        List<byte[]> installedHistory,
        boolean installedHasMultipleSigners,
        List<byte[]> candidateCurrent,
        List<byte[]> candidateHistory,
        boolean candidateHasMultipleSigners
    ) throws Exception {
        if (installedHasMultipleSigners || candidateHasMultipleSigners) {
            return installedHasMultipleSigners &&
                candidateHasMultipleSigners &&
                sameSignerSet(installedCurrent, candidateCurrent);
        }
        if (installedCurrent == null || candidateCurrent == null || installedCurrent.size() != 1 || candidateCurrent.size() != 1) {
            return false;
        }

        List<String> installedLineage = orderedSignerFingerprints(installedHistory);
        List<String> candidateLineage = orderedSignerFingerprints(candidateHistory);
        if (installedLineage.isEmpty() || candidateLineage.isEmpty()) return false;
        String installedSigner = signerFingerprint(installedCurrent.get(0));
        String candidateSigner = signerFingerprint(candidateCurrent.get(0));
        if (installedSigner == null || candidateSigner == null) return false;
        if (!installedSigner.equals(installedLineage.get(installedLineage.size() - 1))) return false;
        if (!candidateSigner.equals(candidateLineage.get(candidateLineage.size() - 1))) return false;
        if (new HashSet<>(installedLineage).size() != installedLineage.size()) return false;
        if (new HashSet<>(candidateLineage).size() != candidateLineage.size()) return false;
        if (installedSigner.equals(candidateSigner)) return true;

        int installedSignerInCandidateHistory = candidateLineage.indexOf(installedSigner);
        return installedSignerInCandidateHistory >= 0 &&
            installedSignerInCandidateHistory < candidateLineage.size() - 1;
    }

    static int compareVersions(String left, String right) {
        int[] leftParts = strictVersionParts(left);
        int[] rightParts = strictVersionParts(right);
        for (int index = 0; index < leftParts.length; index += 1) {
            int comparison = Integer.compare(leftParts[index], rightParts[index]);
            if (comparison != 0) return comparison;
        }
        return 0;
    }

    static String expectedAssetName(String version, String platform, String kind, String arch) {
        strictVersionParts(version);
        String identity = platform + ":" + kind + ":" + arch;
        switch (identity) {
            case "android:apk:universal":
                return "T4-Code-" + version + "-android.apk";
            case "linux:deb:x86_64":
                return "T4-Code-" + version + "-linux-amd64.deb";
            case "linux:appimage:x86_64":
                return "T4-Code-" + version + "-linux-x86_64.AppImage";
            case "mac:dmg:arm64":
                return "T4-Code-" + version + "-mac-arm64.dmg";
            case "mac:zip:arm64":
                return "T4-Code-" + version + "-mac-arm64.zip";
            default:
                throw new IllegalArgumentException("unknown release asset");
        }
    }

    static void requireManifestReleaseIdentity(
        String version,
        String tag,
        String releaseUrl,
        String publishedAt
    ) {
        strictVersionParts(version);
        String expectedTag = "v" + version;
        if (!expectedTag.equals(tag)) throw new IllegalArgumentException("release tag mismatch");
        if (!(RELEASE_PAGE_ROOT + expectedTag).equals(releaseUrl)) {
            throw new IllegalArgumentException("release page mismatch");
        }
        if (publishedAt == null || publishedAt.length() > 64 || !PUBLISHED_AT_PATTERN.matcher(publishedAt).matches()) {
            throw new IllegalArgumentException("invalid release timestamp");
        }
    }

    static String requireManifestAsset(
        String version,
        String platform,
        String kind,
        String arch,
        String name,
        String url,
        long size,
        String sha256,
        long maximumSize
    ) {
        String identity = platform + ":" + kind + ":" + arch;
        String expectedName = expectedAssetName(version, platform, kind, arch);
        if (!expectedName.equals(name)) throw new IllegalArgumentException("release asset name mismatch");
        String expectedUrl = RELEASE_DOWNLOAD_ROOT + "v" + version + "/" + expectedName;
        if (!expectedUrl.equals(url)) throw new IllegalArgumentException("release asset URL mismatch");
        if (size <= 0 || size > maximumSize) throw new IllegalArgumentException("invalid release asset size");
        if (!isValidSha256(sha256)) throw new IllegalArgumentException("invalid release asset digest");
        return identity;
    }

    static void requireAllowedAssetUrl(URL url, boolean initial) {
        if (!"https".equals(url.getProtocol()) || url.getUserInfo() != null || (url.getPort() != -1 && url.getPort() != 443)) {
            throw new IllegalArgumentException("release asset connection is not secure");
        }
        String host = url.getHost().toLowerCase(java.util.Locale.ROOT);
        boolean trustedDownloadHost = "release-assets.githubusercontent.com".equals(host) ||
            "objects.githubusercontent.com".equals(host);
        if (initial ? !"github.com".equals(host) : !("github.com".equals(host) || trustedDownloadHost)) {
            throw new IllegalArgumentException("release asset host is not allowed");
        }
    }

    static boolean isRedirectStatus(int status) {
        return status == HttpURLConnection.HTTP_MOVED_PERM ||
            status == HttpURLConnection.HTTP_MOVED_TEMP ||
            status == HttpURLConnection.HTTP_SEE_OTHER ||
            status == 307 ||
            status == 308;
    }

    static boolean isValidSha256(String value) {
        return value != null && SHA256_PATTERN.matcher(value).matches();
    }

    static boolean isValidVersion(String value) {
        return value != null && VERSION_PATTERN.matcher(value).matches();
    }

    private static Set<String> signerFingerprints(List<byte[]> certificates) throws Exception {
        Set<String> fingerprints = new HashSet<>();
        for (byte[] certificate : certificates) {
            if (certificate == null || certificate.length == 0) return new HashSet<>();
            fingerprints.add(lowercaseHex(MessageDigest.getInstance("SHA-256").digest(certificate)));
        }
        return fingerprints;
    }

    private static List<String> orderedSignerFingerprints(List<byte[]> certificates) throws Exception {
        List<String> fingerprints = new ArrayList<>();
        if (certificates == null) return fingerprints;
        for (byte[] certificate : certificates) {
            String fingerprint = signerFingerprint(certificate);
            if (fingerprint == null) return new ArrayList<>();
            fingerprints.add(fingerprint);
        }
        return fingerprints;
    }

    private static String signerFingerprint(byte[] certificate) throws Exception {
        if (certificate == null || certificate.length == 0) return null;
        return lowercaseHex(MessageDigest.getInstance("SHA-256").digest(certificate));
    }

    private static int[] strictVersionParts(String version) {
        if (version == null || !VERSION_PATTERN.matcher(version).matches()) {
            throw new IllegalArgumentException("release version is invalid");
        }
        String[] values = version.split("\\.");
        return new int[] {
            Integer.parseInt(values[0]),
            Integer.parseInt(values[1]),
            Integer.parseInt(values[2]),
        };
    }

    private static String lowercaseHex(byte[] value) {
        StringBuilder result = new StringBuilder(value.length * 2);
        for (byte item : value) result.append(String.format(java.util.Locale.ROOT, "%02x", item & 0xff));
        return result.toString();
    }
}
