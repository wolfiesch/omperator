package com.lycaonsolutions.t4code;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import org.junit.Test;

public final class T4UpdateStateMachineTest {
    @Test
    public void onlyOneConcurrentDownloadCanStart() throws Exception {
        T4UpdateStateMachine state = new T4UpdateStateMachine();
        assertTrue(state.beginCheck());
        assertTrue(state.finishCheck("available"));

        int workers = 12;
        ExecutorService executor = Executors.newFixedThreadPool(workers);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<T4UpdateStateMachine.DownloadStart>> attempts = new ArrayList<>();
        for (int index = 0; index < workers; index += 1) {
            attempts.add(executor.submit(() -> {
                start.await();
                return state.beginDownload(true);
            }));
        }
        start.countDown();

        int started = 0;
        int busy = 0;
        for (Future<T4UpdateStateMachine.DownloadStart> attempt : attempts) {
            T4UpdateStateMachine.DownloadStart result = attempt.get();
            if (result == T4UpdateStateMachine.DownloadStart.STARTED) started += 1;
            else if (result == T4UpdateStateMachine.DownloadStart.BUSY) busy += 1;
        }
        executor.shutdownNow();

        assertEquals(1, started);
        assertEquals(workers - 1, busy);
        assertEquals("downloading", state.phase());
        assertFalse(state.beginCheck());
    }

    @Test
    public void concurrentChecksProduceOneNativeTransition() throws Exception {
        T4UpdateStateMachine state = new T4UpdateStateMachine();
        int workers = 12;
        ExecutorService executor = Executors.newFixedThreadPool(workers);
        CountDownLatch start = new CountDownLatch(1);
        List<Future<Boolean>> attempts = new ArrayList<>();
        for (int index = 0; index < workers; index += 1) {
            attempts.add(executor.submit(() -> {
                start.await();
                return state.beginCheck();
            }));
        }
        start.countDown();

        int started = 0;
        for (Future<Boolean> attempt : attempts) {
            if (attempt.get()) started += 1;
        }
        executor.shutdownNow();

        assertEquals(1, started);
        assertEquals("checking", state.phase());
        assertEquals(1, state.revision());
    }

    @Test
    public void staleCheckCompletionCannotReplaceAResetState() {
        T4UpdateStateMachine state = new T4UpdateStateMachine();
        assertTrue(state.beginCheck());
        state.reset();
        long resetRevision = state.revision();

        assertFalse(state.finishCheck("available"));
        assertEquals("idle", state.phase());
        assertEquals(resetRevision, state.revision());
    }

    @Test
    public void installerHandoffCannotStartAReplacementDownload() {
        T4UpdateStateMachine state = new T4UpdateStateMachine();
        assertTrue(state.beginCheck());
        assertTrue(state.finishCheck("available"));
        assertEquals(T4UpdateStateMachine.DownloadStart.STARTED, state.beginDownload(true));
        state.downloadSucceeded();
        state.installerOpened();

        assertEquals("installer", state.phase());
        long handoffRevision = state.revision();
        assertEquals(T4UpdateStateMachine.DownloadStart.HANDED_OFF, state.beginDownload(true));
        assertEquals(handoffRevision, state.revision());
        assertFalse(state.beginCheck());
    }

    @Test
    public void installerReturnAllowsTheVerifiedReleaseToBeRetried() {
        T4UpdateStateMachine state = new T4UpdateStateMachine();
        assertTrue(state.beginCheck());
        assertTrue(state.finishCheck("available"));
        assertEquals(T4UpdateStateMachine.DownloadStart.STARTED, state.beginDownload(true));
        state.downloadSucceeded();
        state.installerOpened();
        state.installerReturned(true);

        assertEquals("available", state.phase());
        assertEquals(T4UpdateStateMachine.DownloadStart.STARTED, state.beginDownload(true));
    }

    @Test
    public void failedDownloadRequiresANewSuccessfulCheck() {
        T4UpdateStateMachine state = new T4UpdateStateMachine();
        assertTrue(state.beginCheck());
        assertTrue(state.finishCheck("available"));
        assertEquals(T4UpdateStateMachine.DownloadStart.STARTED, state.beginDownload(true));
        state.downloadFailed();

        assertEquals("error", state.phase());
        assertEquals(T4UpdateStateMachine.DownloadStart.UNAVAILABLE, state.beginDownload(true));
        assertTrue(state.beginCheck());
        assertTrue(state.finishCheck("current"));
        assertEquals("current", state.phase());
    }
}
