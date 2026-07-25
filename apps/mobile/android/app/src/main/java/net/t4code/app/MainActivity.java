package net.t4code.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private static final String APP_RESUME_EVENT = "t4:native-resume";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(T4SecureStoragePlugin.class);
        registerPlugin(T4UpdatePlugin.class);
        registerPlugin(T4SpeechPlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onResume() {
        super.onResume();
        if (getBridge() != null) {
            getBridge().triggerWindowJSEvent(APP_RESUME_EVENT);
        }
    }
}
