package com.lycaonsolutions.t4code;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public final class T4UpdateFileStoreTest {
    @Rule
    public final TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void startupRemovesPartialsAndVerifiedFilesButKeepsOneHandoff() throws Exception {
        File directory = temporaryFolder.newFolder("updates");
        File partial = write(directory, "T4-Code-1.2.3-a.apk.partial");
        File verified = write(directory, "T4-Code-1.2.3-b.apk");
        File olderHandoff = write(directory, "T4-Code-1.2.2-a-installer.apk");
        File newerHandoff = write(directory, "T4-Code-1.2.3-b-installer.apk");
        assertTrue(olderHandoff.setLastModified(1_000));
        assertTrue(newerHandoff.setLastModified(2_000));

        T4UpdateFileStore store = new T4UpdateFileStore(directory);
        File retained = store.prepareOnStartup();

        assertEquals(newerHandoff.getAbsoluteFile(), retained.getAbsoluteFile());
        assertFalse(partial.exists());
        assertFalse(verified.exists());
        assertFalse(olderHandoff.exists());
        assertTrue(newerHandoff.exists());
        assertEquals(1, fileCount(directory));
    }

    @Test
    public void foregroundDownloadClearsAProcessDeathHandoff() throws Exception {
        File directory = temporaryFolder.newFolder("updates");
        File oldHandoff = write(directory, "T4-Code-1.2.2-a-installer.apk");
        T4UpdateFileStore store = new T4UpdateFileStore(directory);
        assertNotNull(store.prepareOnStartup());

        store.prepareForDownload();

        assertFalse(oldHandoff.exists());
        assertNull(store.activeHandoff());
        assertEquals(0, fileCount(directory));
    }

    @Test
    public void installerHandoffSurvivesDestroyThenIsRemovedOnReturn() throws Exception {
        File directory = temporaryFolder.newFolder("updates");
        T4UpdateFileStore store = new T4UpdateFileStore(directory);
        store.prepareForDownload();
        File partial = store.createPartial("1.2.3");
        writeBytes(partial);
        File verified = store.finalizeVerified(partial);
        File handoff = store.beginInstallerHandoff(verified);
        File interruptedAfterHandoff = store.createPartial("1.2.4");
        writeBytes(interruptedAfterHandoff);

        assertFalse(partial.exists());
        assertFalse(verified.exists());
        assertTrue(handoff.exists());
        assertTrue(handoff.getName().endsWith("-installer.apk"));

        store.cleanupForDestroy();
        assertTrue(handoff.exists());
        assertFalse(interruptedAfterHandoff.exists());
        assertEquals(1, fileCount(directory));

        T4UpdateFileStore recreated = new T4UpdateFileStore(directory);
        File recovered = recreated.prepareOnStartup();
        assertEquals(handoff.getAbsoluteFile(), recovered.getAbsoluteFile());
        recreated.finishInstallerHandoff(recovered);

        assertFalse(handoff.exists());
        assertNull(recreated.activeHandoff());
        assertEquals(0, fileCount(directory));
    }

    @Test
    public void destroyRemovesInterruptedAndUnhandedPackages() throws Exception {
        File directory = temporaryFolder.newFolder("updates");
        T4UpdateFileStore store = new T4UpdateFileStore(directory);
        store.prepareForDownload();
        File partial = store.createPartial("1.2.3");
        writeBytes(partial);
        File verified = store.finalizeVerified(partial);
        File secondPartial = store.createPartial("1.2.4");
        writeBytes(secondPartial);

        store.cleanupForDestroy();

        assertFalse(partial.exists());
        assertFalse(verified.exists());
        assertFalse(secondPartial.exists());
        assertEquals(0, fileCount(directory));
    }

    @Test
    public void staleActivityCannotSweepANewerInstallerHandoff() throws Exception {
        File directory = temporaryFolder.newFolder("updates");
        T4UpdateFileStore stale = new T4UpdateFileStore(directory);
        stale.prepareOnStartup();

        T4UpdateFileStore current = new T4UpdateFileStore(directory);
        current.prepareOnStartup();
        current.prepareForDownload();
        File partial = current.createPartial("1.2.3");
        writeBytes(partial);
        File handoff = current.beginInstallerHandoff(current.finalizeVerified(partial));

        assertThrows(IOException.class, stale::prepareForDownload);
        stale.cleanupForDestroy();
        stale.discard(handoff);

        assertTrue(handoff.exists());
        assertEquals(handoff.getAbsoluteFile(), current.activeHandoff().getAbsoluteFile());
        assertEquals(1, fileCount(directory));
    }

    private static File write(File directory, String name) throws Exception {
        File file = new File(directory, name);
        writeBytes(file);
        return file;
    }

    private static void writeBytes(File file) throws Exception {
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(new byte[] { 1, 2, 3, 4 });
            output.getFD().sync();
        }
    }

    private static int fileCount(File directory) {
        File[] files = directory.listFiles();
        return files == null ? 0 : files.length;
    }
}
