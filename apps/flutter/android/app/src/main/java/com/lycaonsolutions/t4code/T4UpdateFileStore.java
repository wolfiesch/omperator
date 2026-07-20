package com.lycaonsolutions.t4code;

import java.io.File;
import java.io.IOException;
import java.util.HashMap;
import java.util.Map;

/**
 * Owns the app-private APK cache used by the updater.
 *
 * A normal verified APK is temporary. An {@code -installer.apk} file is the
 * one exception: it is retained while Android's package installer owns a
 * read-only content URI, then removed when T4 returns to the foreground.
 */
final class T4UpdateFileStore {
    private static final String PARTIAL_SUFFIX = ".apk.partial";
    private static final String APK_SUFFIX = ".apk";
    private static final String HANDOFF_SUFFIX = "-installer.apk";
    private static final Object OWNERSHIP_LOCK = new Object();
    private static final Map<String, Object> ACTIVE_OWNERS = new HashMap<>();

    private final File directory;
    private final String ownershipKey;
    private final Object ownerToken = new Object();
    private File activeHandoff;

    T4UpdateFileStore(File directory) {
        this.directory = directory;
        ownershipKey = normalizedPath(directory);
        synchronized (OWNERSHIP_LOCK) {
            ACTIVE_OWNERS.put(ownershipKey, ownerToken);
        }
    }

    /**
     * Removes interrupted downloads and unhanded verified packages. At most
     * one prior installer handoff survives until the activity is foregrounded.
     */
    synchronized File prepareOnStartup() throws IOException {
        synchronized (OWNERSHIP_LOCK) {
            requireOwnership();
            ensureDirectory();
            File keep = newestHandoff();
            cleanExcept(keep);
            activeHandoff = keep != null && keep.isFile() ? keep : null;
            return activeHandoff;
        }
    }

    /** The user is foregrounded and starting a new download, so no old handoff is live. */
    synchronized void prepareForDownload() throws IOException {
        synchronized (OWNERSHIP_LOCK) {
            requireOwnership();
            ensureDirectory();
            cleanExcept(null);
            activeHandoff = null;
        }
    }

    synchronized File createPartial(String version) throws IOException {
        synchronized (OWNERSHIP_LOCK) {
            requireOwnership();
            ensureDirectory();
            return File.createTempFile("T4-Code-" + version + "-", PARTIAL_SUFFIX, directory);
        }
    }

    synchronized File finalizeVerified(File partial) throws IOException {
        synchronized (OWNERSHIP_LOCK) {
            requireOwnership();
            requireManagedFile(partial, PARTIAL_SUFFIX);
            String partialName = partial.getName();
            File verified = new File(directory, partialName.substring(0, partialName.length() - ".partial".length()));
            deleteIfPresent(verified);
            if (!partial.renameTo(verified)) {
                throw new IOException("could not finalize verified update");
            }
            if (!verified.setReadOnly()) {
                deleteIfPresent(verified);
                throw new IOException("could not protect verified update");
            }
            return verified;
        }
    }

    /**
     * Renames the verified file before its URI is granted. The distinctive
     * suffix is the process-death marker that lets a new plugin instance keep
     * exactly this one file until T4 is foregrounded again.
     */
    synchronized File beginInstallerHandoff(File verified) throws IOException {
        synchronized (OWNERSHIP_LOCK) {
            requireOwnership();
            requireManagedFile(verified, APK_SUFFIX);
            if (isHandoff(verified)) throw new IOException("update is already handed to the installer");
            String name = verified.getName();
            File handoff = new File(directory, name.substring(0, name.length() - APK_SUFFIX.length()) + HANDOFF_SUFFIX);
            cleanHandoffsExcept(null);
            deleteIfPresent(handoff);
            if (!verified.renameTo(handoff)) {
                throw new IOException("could not prepare update for the installer");
            }
            activeHandoff = handoff;
            return handoff;
        }
    }

    synchronized void finishInstallerHandoff(File handoff) throws IOException {
        synchronized (OWNERSHIP_LOCK) {
            requireOwnership();
            requireManagedFileOrMissing(handoff, HANDOFF_SUFFIX);
            deleteIfPresent(handoff);
            if (sameFile(activeHandoff, handoff)) activeHandoff = null;
        }
    }

    synchronized void discard(File file) {
        synchronized (OWNERSHIP_LOCK) {
            if (!ownsDirectory() || file == null || !isDirectChild(file)) return;
            file.delete();
            if (sameFile(activeHandoff, file)) activeHandoff = null;
        }
    }

    /** Destroy may interrupt a worker, but must not revoke a URI already owned by the installer. */
    synchronized void cleanupForDestroy() {
        synchronized (OWNERSHIP_LOCK) {
            if (!ownsDirectory()) return;
            try {
                ensureDirectory();
                cleanExcept(activeHandoff);
            } catch (IOException ignored) {
                // Startup and pre-download sweeps retry cleanup on the next plugin instance.
            }
        }
    }

    synchronized File activeHandoff() {
        synchronized (OWNERSHIP_LOCK) {
            return ownsDirectory() ? activeHandoff : null;
        }
    }

    private void requireOwnership() throws IOException {
        if (!ownsDirectory()) throw new IOException("update storage belongs to a newer Android activity");
    }

    private boolean ownsDirectory() {
        return ACTIVE_OWNERS.get(ownershipKey) == ownerToken;
    }

    private static String normalizedPath(File directory) {
        try {
            return directory.getCanonicalPath();
        } catch (IOException ignored) {
            return directory.getAbsoluteFile().toURI().normalize().getPath();
        }
    }

    private void ensureDirectory() throws IOException {
        if ((!directory.isDirectory() && !directory.mkdirs()) || !directory.isDirectory()) {
            throw new IOException("could not create private update directory");
        }
    }

    private File newestHandoff() throws IOException {
        File newest = null;
        for (File entry : entries()) {
            if (!entry.isFile() || !isHandoff(entry)) continue;
            if (
                newest == null ||
                entry.lastModified() > newest.lastModified() ||
                (entry.lastModified() == newest.lastModified() && entry.getName().compareTo(newest.getName()) > 0)
            ) {
                newest = entry;
            }
        }
        return newest;
    }

    private void cleanExcept(File keep) throws IOException {
        for (File entry : entries()) {
            if (sameFile(entry, keep)) continue;
            deleteIfPresent(entry);
        }
    }

    private void cleanHandoffsExcept(File keep) throws IOException {
        for (File entry : entries()) {
            if (!isHandoff(entry) || sameFile(entry, keep)) continue;
            deleteIfPresent(entry);
        }
    }

    private File[] entries() throws IOException {
        File[] entries = directory.listFiles();
        if (entries == null) throw new IOException("could not inspect private update directory");
        return entries;
    }

    private void requireManagedFile(File file, String suffix) throws IOException {
        requireManagedFileOrMissing(file, suffix);
        if (!file.isFile()) throw new IOException("update file is missing");
    }

    private void requireManagedFileOrMissing(File file, String suffix) throws IOException {
        if (file == null || !isDirectChild(file) || !file.getName().endsWith(suffix)) {
            throw new IOException("update file is outside the private update directory");
        }
    }

    private boolean isDirectChild(File file) {
        File parent = file.getAbsoluteFile().getParentFile();
        return parent != null && parent.equals(directory.getAbsoluteFile());
    }

    private boolean isHandoff(File file) {
        return file.getName().endsWith(HANDOFF_SUFFIX);
    }

    private boolean sameFile(File first, File second) {
        return first != null && second != null && first.getAbsoluteFile().equals(second.getAbsoluteFile());
    }

    private void deleteIfPresent(File file) throws IOException {
        if (file.exists() && !file.delete()) throw new IOException("could not remove stale update file");
    }
}
