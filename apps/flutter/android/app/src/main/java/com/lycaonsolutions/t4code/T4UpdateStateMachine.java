package com.lycaonsolutions.t4code;

/** Small synchronized state machine so bridge calls and the download worker cannot race. */
final class T4UpdateStateMachine {
    enum DownloadStart {
        STARTED,
        BUSY,
        HANDED_OFF,
        UNAVAILABLE,
    }

    private String phase = "idle";
    private long revision;
    private boolean downloadInProgress;

    synchronized String phase() {
        return phase;
    }

    synchronized long revision() {
        return revision;
    }

    synchronized boolean beginCheck() {
        if (downloadInProgress || "checking".equals(phase) || "installer".equals(phase)) return false;
        transition("checking");
        return true;
    }

    synchronized boolean finishCheck(String resultPhase) {
        if (!("available".equals(resultPhase) || "current".equals(resultPhase) || "error".equals(resultPhase))) {
            throw new IllegalArgumentException("invalid check result phase");
        }
        if (downloadInProgress || !"checking".equals(phase)) return false;
        transition(resultPhase);
        return true;
    }

    synchronized DownloadStart beginDownload(boolean hasValidatedRelease) {
        if (downloadInProgress || "downloading".equals(phase)) return DownloadStart.BUSY;
        if ("installer".equals(phase)) return DownloadStart.HANDED_OFF;
        if (!hasValidatedRelease || !"available".equals(phase)) return DownloadStart.UNAVAILABLE;
        downloadInProgress = true;
        transition("downloading");
        return DownloadStart.STARTED;
    }

    synchronized void downloadSucceeded() {
        requireActiveDownload();
        downloadInProgress = false;
        transition("available");
    }

    synchronized void installerOpened() {
        if (downloadInProgress || !"available".equals(phase)) {
            throw new IllegalStateException("no verified update is ready for installation");
        }
        transition("installer");
    }

    synchronized void installerReturned(boolean updateStillAvailable) {
        if (!"installer".equals(phase) || downloadInProgress) {
            throw new IllegalStateException("no installer handoff is active");
        }
        transition(updateStillAvailable ? "available" : "idle");
    }

    synchronized void downloadFailed() {
        requireActiveDownload();
        downloadInProgress = false;
        transition("error");
    }

    synchronized void reset() {
        downloadInProgress = false;
        transition("idle");
    }

    private void requireActiveDownload() {
        if (!downloadInProgress || !"downloading".equals(phase)) {
            throw new IllegalStateException("no verified update download is active");
        }
    }

    private void transition(String nextPhase) {
        phase = nextPhase;
        revision += 1;
    }
}
