package com.lycaonsolutions.t4code;

import androidx.annotation.NonNull;

import java.util.List;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

import io.flutter.embedding.android.FlutterActivity;
import io.flutter.embedding.engine.FlutterEngine;
import io.flutter.plugin.common.MethodChannel;

public class MainActivity extends FlutterActivity {
    private static final String LEGACY_CREDENTIAL_CHANNEL =
        "com.lycaonsolutions.t4code/legacy_credentials";
    private T4UpdatePlugin updatePlugin;

    private final ExecutorService legacyCredentialExecutor = new ThreadPoolExecutor(
        1,
        1,
        0L,
        TimeUnit.MILLISECONDS,
        new ArrayBlockingQueue<>(8)
    );

    @Override
    public void configureFlutterEngine(@NonNull FlutterEngine flutterEngine) {
        super.configureFlutterEngine(flutterEngine);
        if (updatePlugin != null) updatePlugin.destroy();
        updatePlugin = new T4UpdatePlugin(this);
        new MethodChannel(
            flutterEngine.getDartExecutor().getBinaryMessenger(),
            T4UpdatePlugin.CHANNEL_NAME
        ).setMethodCallHandler(updatePlugin::handle);

        LegacyCredentialMigration migration = new LegacyCredentialMigration(this);
        new MethodChannel(
            flutterEngine.getDartExecutor().getBinaryMessenger(),
            LEGACY_CREDENTIAL_CHANNEL
        ).setMethodCallHandler((call, result) -> {
            try {
                switch (call.method) {
                    case "discoverCredentials":
                        List<?> hostKeys = call.argument("hostKeys");
                        Boolean includeUnkeyed = call.argument("includeUnkeyed");
                        if (hostKeys == null || hostKeys.isEmpty() || includeUnkeyed == null) {
                            throw new IllegalArgumentException("Invalid discovery request.");
                        }
                        executeLegacyOperation(
                            result,
                            () -> migration.discover(hostKeys, includeUnkeyed)
                        );
                        break;
                    case "clearCredentials":
                        String source = call.argument("source");
                        executeLegacyOperation(result, () -> {
                            migration.clear(source);
                            return null;
                        });
                        break;
                    default:
                        result.notImplemented();
                        break;
                }
            } catch (Exception error) {
                sendLegacyError(result);
            }
        });
    }

    @Override
    protected void onPause() {
        if (updatePlugin != null) updatePlugin.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (updatePlugin != null) updatePlugin.onResume();
    }

    @Override
    protected void onDestroy() {
        if (updatePlugin != null) {
            updatePlugin.destroy();
            updatePlugin = null;
        }
        legacyCredentialExecutor.shutdownNow();
        super.onDestroy();
    }

    private void executeLegacyOperation(
        MethodChannel.Result result,
        LegacyOperation operation
    ) {
        try {
            legacyCredentialExecutor.execute(() -> {
                try {
                    Object value = operation.run();
                    runOnUiThread(() -> result.success(value));
                } catch (Exception error) {
                    runOnUiThread(() -> sendLegacyError(result));
                }
            });
        } catch (RejectedExecutionException error) {
            sendLegacyError(result);
        }
    }

    private void sendLegacyError(MethodChannel.Result result) {
        result.error(
            "legacy_credentials_unavailable",
            "Legacy credentials could not be migrated.",
            null
        );
    }

    private interface LegacyOperation {
        Object run() throws Exception;
    }
}
