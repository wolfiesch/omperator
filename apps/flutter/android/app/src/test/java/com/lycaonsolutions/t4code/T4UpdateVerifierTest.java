package com.lycaonsolutions.t4code;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.net.URL;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Collections;

import org.junit.Test;

public final class T4UpdateVerifierTest {
    @Test
    public void exactStreamAcceptsOnlyDeclaredBytesAndDigest() throws Exception {
        byte[] packageBytes = "verified android package".getBytes(StandardCharsets.UTF_8);
        ByteArrayOutputStream output = new ByteArrayOutputStream();

        T4UpdateVerifier.copyExact(
            new ByteArrayInputStream(packageBytes),
            output,
            packageBytes.length,
            sha256(packageBytes)
        );

        assertArrayEquals(packageBytes, output.toByteArray());
    }

    @Test
    public void exactStreamRejectsOversizedUndersizedAndAlteredPackages() throws Exception {
        byte[] packageBytes = "package".getBytes(StandardCharsets.UTF_8);

        assertThrows(
            IllegalStateException.class,
            () -> T4UpdateVerifier.copyExact(
                new ByteArrayInputStream(packageBytes),
                new ByteArrayOutputStream(),
                packageBytes.length - 1,
                sha256(packageBytes)
            )
        );
        assertThrows(
            IllegalStateException.class,
            () -> T4UpdateVerifier.copyExact(
                new ByteArrayInputStream(packageBytes),
                new ByteArrayOutputStream(),
                packageBytes.length + 1,
                sha256(packageBytes)
            )
        );
        assertThrows(
            IllegalStateException.class,
            () -> T4UpdateVerifier.copyExact(
                new ByteArrayInputStream(packageBytes),
                new ByteArrayOutputStream(),
                packageBytes.length,
                sha256("different".getBytes(StandardCharsets.UTF_8))
            )
        );
    }

    @Test
    public void signerSetRequiresTheSameNonEmptyCertificatesRegardlessOfOrder() throws Exception {
        byte[] first = "first certificate".getBytes(StandardCharsets.UTF_8);
        byte[] second = "second certificate".getBytes(StandardCharsets.UTF_8);
        byte[] other = "other certificate".getBytes(StandardCharsets.UTF_8);

        assertTrue(T4UpdateVerifier.sameSignerSet(Arrays.asList(first, second), Arrays.asList(second, first)));
        assertFalse(T4UpdateVerifier.sameSignerSet(Arrays.asList(first, second), Arrays.asList(first, other)));
        assertFalse(T4UpdateVerifier.sameSignerSet(Arrays.asList(first, second), Collections.singletonList(first)));
        assertFalse(T4UpdateVerifier.sameSignerSet(Collections.emptyList(), Collections.singletonList(first)));
    }

    @Test
    public void signerTransitionAcceptsVerifiedForwardRotationAndRejectsRollback() throws Exception {
        byte[] first = "first certificate".getBytes(StandardCharsets.UTF_8);
        byte[] second = "second certificate".getBytes(StandardCharsets.UTF_8);
        byte[] third = "third certificate".getBytes(StandardCharsets.UTF_8);

        assertTrue(T4UpdateVerifier.isTrustedSignerTransition(
            Collections.singletonList(first),
            Collections.singletonList(first),
            false,
            Collections.singletonList(second),
            Arrays.asList(first, second),
            false
        ));
        assertTrue(T4UpdateVerifier.isTrustedSignerTransition(
            Collections.singletonList(second),
            Arrays.asList(first, second),
            false,
            Collections.singletonList(second),
            Collections.singletonList(second),
            false
        ));
        assertFalse(T4UpdateVerifier.isTrustedSignerTransition(
            Collections.singletonList(second),
            Arrays.asList(first, second),
            false,
            Collections.singletonList(first),
            Collections.singletonList(first),
            false
        ));
        assertTrue(T4UpdateVerifier.isTrustedSignerTransition(
            Collections.singletonList(second),
            Arrays.asList(first, second),
            false,
            Collections.singletonList(third),
            Arrays.asList(first, second, third),
            false
        ));
    }

    @Test
    public void signerTransitionRejectsMalformedOrUnprovenLineage() throws Exception {
        byte[] first = "first certificate".getBytes(StandardCharsets.UTF_8);
        byte[] second = "second certificate".getBytes(StandardCharsets.UTF_8);
        byte[] third = "third certificate".getBytes(StandardCharsets.UTF_8);

        assertFalse(T4UpdateVerifier.isTrustedSignerTransition(
            Collections.singletonList(first),
            Collections.emptyList(),
            false,
            Collections.singletonList(second),
            Arrays.asList(first, second),
            false
        ));
        assertFalse(T4UpdateVerifier.isTrustedSignerTransition(
            Collections.singletonList(first),
            Collections.singletonList(first),
            false,
            Collections.singletonList(second),
            Arrays.asList(second, first),
            false
        ));
        assertFalse(T4UpdateVerifier.isTrustedSignerTransition(
            Collections.singletonList(first),
            Collections.singletonList(first),
            false,
            Collections.singletonList(second),
            Arrays.asList(first, first, second),
            false
        ));
        assertFalse(T4UpdateVerifier.isTrustedSignerTransition(
            Collections.singletonList(first),
            Collections.singletonList(second),
            false,
            Collections.singletonList(second),
            Arrays.asList(first, second),
            false
        ));
        assertFalse(T4UpdateVerifier.isTrustedSignerTransition(
            Collections.singletonList(second),
            Arrays.asList(first, second),
            false,
            Collections.singletonList(third),
            Arrays.asList(first, third),
            false
        ));
    }

    @Test
    public void multiSignerTransitionRequiresTheSameCompleteSignerSet() throws Exception {
        byte[] first = "first certificate".getBytes(StandardCharsets.UTF_8);
        byte[] second = "second certificate".getBytes(StandardCharsets.UTF_8);

        assertTrue(T4UpdateVerifier.isTrustedSignerTransition(
            Arrays.asList(first, second),
            Collections.emptyList(),
            true,
            Arrays.asList(second, first),
            Collections.emptyList(),
            true
        ));
        assertFalse(T4UpdateVerifier.isTrustedSignerTransition(
            Arrays.asList(first, second),
            Collections.emptyList(),
            true,
            Collections.singletonList(first),
            Collections.singletonList(first),
            false
        ));
    }

    @Test
    public void versionsAssetsAndRedirectsAreStrict() throws Exception {
        assertTrue(T4UpdateVerifier.compareVersions("1.2.4", "1.2.3") > 0);
        assertEquals(0, T4UpdateVerifier.compareVersions("1.2.3", "1.2.3"));
        assertTrue(T4UpdateVerifier.compareVersions("1.2.3", "2.0.0") < 0);
        assertThrows(IllegalArgumentException.class, () -> T4UpdateVerifier.compareVersions("1.2", "1.2.0"));
        assertThrows(IllegalArgumentException.class, () -> T4UpdateVerifier.compareVersions("01.2.3", "1.2.3"));
        assertThrows(IllegalArgumentException.class, () -> T4UpdateVerifier.compareVersions("1.2.3-beta", "1.2.3"));
        assertEquals(
            "T4-Code-1.2.3-android.apk",
            T4UpdateVerifier.expectedAssetName("1.2.3", "android", "apk", "universal")
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> T4UpdateVerifier.expectedAssetName("1.2.3", "android", "aab", "universal")
        );

        T4UpdateVerifier.requireAllowedAssetUrl(
            new URL("https://github.com/LycaonLLC/t4-code/releases/download/v1.2.3/T4-Code-1.2.3-android.apk"),
            true
        );
        T4UpdateVerifier.requireAllowedAssetUrl(
            new URL("https://release-assets.githubusercontent.com/github-production-release-asset/file?token=signed"),
            false
        );
        T4UpdateVerifier.requireAllowedAssetUrl(
            new URL("https://objects.githubusercontent.com/github-production-release-asset/file"),
            false
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> T4UpdateVerifier.requireAllowedAssetUrl(new URL("https://example.com/update.apk"), false)
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> T4UpdateVerifier.requireAllowedAssetUrl(new URL("http://github.com/update.apk"), true)
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> T4UpdateVerifier.requireAllowedAssetUrl(new URL("https://github.com.evil.example/update.apk"), true)
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> T4UpdateVerifier.requireAllowedAssetUrl(new URL("https://user@github.com/update.apk"), true)
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> T4UpdateVerifier.requireAllowedAssetUrl(new URL("https://github.com:444/update.apk"), true)
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> T4UpdateVerifier.requireAllowedAssetUrl(
                new URL("https://release-assets.githubusercontent.com/update.apk"),
                true
            )
        );
        assertTrue(T4UpdateVerifier.isRedirectStatus(302));
        assertTrue(T4UpdateVerifier.isRedirectStatus(308));
        assertFalse(T4UpdateVerifier.isRedirectStatus(200));
    }

    @Test
    public void manifestIdentityAndEveryPublishedAssetAreExact() {
        String version = "1.2.3";
        String digest = String.join("", Collections.nCopies(64, "a"));
        T4UpdateVerifier.requireManifestReleaseIdentity(
            version,
            "v1.2.3",
            "https://github.com/LycaonLLC/t4-code/releases/tag/v1.2.3",
            "2026-07-15T12:30:00.000Z"
        );

        String[][] assets = new String[][] {
            { "android", "apk", "universal", "T4-Code-1.2.3-android.apk" },
            { "linux", "deb", "x86_64", "T4-Code-1.2.3-linux-amd64.deb" },
            { "linux", "appimage", "x86_64", "T4-Code-1.2.3-linux-x86_64.AppImage" },
            { "mac", "dmg", "arm64", "T4-Code-1.2.3-mac-arm64.dmg" },
            { "mac", "zip", "arm64", "T4-Code-1.2.3-mac-arm64.zip" },
        };
        for (String[] asset : assets) {
            assertEquals(
                asset[0] + ":" + asset[1] + ":" + asset[2],
                T4UpdateVerifier.requireManifestAsset(
                    version,
                    asset[0],
                    asset[1],
                    asset[2],
                    asset[3],
                    "https://github.com/LycaonLLC/t4-code/releases/download/v1.2.3/" + asset[3],
                    1024,
                    digest,
                    2048
                )
            );
        }

        assertThrows(
            IllegalArgumentException.class,
            () -> T4UpdateVerifier.requireManifestReleaseIdentity(
                version,
                "v1.2.4",
                "https://github.com/LycaonLLC/t4-code/releases/tag/v1.2.3",
                "2026-07-15T12:30:00Z"
            )
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> T4UpdateVerifier.requireManifestReleaseIdentity(
                version,
                "v1.2.3",
                "https://example.com/v1.2.3",
                "not-a-timestamp"
            )
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> T4UpdateVerifier.requireManifestAsset(
                version,
                "android",
                "apk",
                "universal",
                "T4-Code-1.2.3-android.apk",
                "https://example.com/T4-Code-1.2.3-android.apk",
                1024,
                digest,
                2048
            )
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> T4UpdateVerifier.requireManifestAsset(
                version,
                "android",
                "apk",
                "universal",
                "T4-Code-1.2.3-android.apk",
                "https://github.com/LycaonLLC/t4-code/releases/download/v1.2.3/T4-Code-1.2.3-android.apk",
                2049,
                digest,
                2048
            )
        );
        assertThrows(
            IllegalArgumentException.class,
            () -> T4UpdateVerifier.requireManifestAsset(
                version,
                "android",
                "apk",
                "universal",
                "T4-Code-1.2.3-android.apk",
                "https://github.com/LycaonLLC/t4-code/releases/download/v1.2.3/T4-Code-1.2.3-android.apk",
                1024,
                digest.toUpperCase(java.util.Locale.ROOT),
                2048
            )
        );
    }

    private static String sha256(byte[] input) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-256").digest(input);
        StringBuilder result = new StringBuilder(digest.length * 2);
        for (byte item : digest) result.append(String.format(java.util.Locale.ROOT, "%02x", item & 0xff));
        return result.toString();
    }
}
