package net.t4code.app;

import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

@CapacitorPlugin(name = "T4Speech")
public final class T4SpeechPlugin extends Plugin {
    private final Object lock = new Object();
    private final Map<String, PluginCall> pending = new HashMap<>();
    private TextToSpeech textToSpeech;
    private boolean ready;
    private boolean destroyed;

    @Override public void load() {
        synchronized (lock) {
            destroyed = false; ready = false;
            textToSpeech = new TextToSpeech(getContext(), status -> {
                synchronized (lock) { if (!destroyed && textToSpeech != null) { ready = status == TextToSpeech.SUCCESS; if (ready) textToSpeech.setLanguage(Locale.getDefault()); } }
            });
            textToSpeech.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                @Override public void onStart(String id) { }
                @Override public void onDone(String id) { finish(id, true, null); }
                @Override public void onError(String id) { finish(id, false, "Speech synthesis failed"); }
                @Override public void onStop(String id, boolean interrupted) { finish(id, false, "Speech cancelled"); }
            });
        }
    }

    @PluginMethod public void speakText(PluginCall call) {
        String text = call.getString("text");
        int max = TextToSpeech.getMaxSpeechInputLength();
        if (text == null || text.length() == 0 || text.length() > max || text.indexOf('\0') >= 0) { resolve(call, false, "invalid speech text"); return; }
        synchronized (lock) {
            if (destroyed || !ready || textToSpeech == null) { resolve(call, false, "Speech synthesis is unavailable"); return; }
            stopPendingLocked();
            String id = UUID.randomUUID().toString(); pending.put(id, call);
            int status = textToSpeech.speak(text, TextToSpeech.QUEUE_FLUSH, null, id);
            if (status != TextToSpeech.SUCCESS) { pending.remove(id); resolve(call, false, "Speech synthesis is unavailable"); }
        }
    }

    @PluginMethod public void stopSpeaking(PluginCall call) {
        synchronized (lock) { if (textToSpeech != null) textToSpeech.stop(); stopPendingLocked(); resolve(call, !destroyed, destroyed ? "Speech service is stopped" : null); }
    }

    private void finish(String id, boolean accepted, String error) { synchronized (lock) { PluginCall call = pending.remove(id); if (call != null) resolve(call, accepted, error); } }
    private void stopPendingLocked() { for (PluginCall call : pending.values()) resolve(call, false, "Speech cancelled"); pending.clear(); }
    private static void resolve(PluginCall call, boolean accepted, String error) { JSObject result = new JSObject(); result.put("accepted", accepted); if (error != null) result.put("error", error); call.resolve(result); }

    @Override protected void handleOnDestroy() { synchronized (lock) { destroyed = true; ready = false; if (textToSpeech != null) { textToSpeech.stop(); textToSpeech.shutdown(); textToSpeech = null; } stopPendingLocked(); } super.handleOnDestroy(); }
}
