# T4 Code Mobile

Android thin-client shell for the bundled T4 Code web application. The APK contains the UI assets and connects over secure WebSocket to a separately running T4 Tailnet gateway; it never embeds or starts an OMP appserver.

## Build

```bash
pnpm build:web
pnpm --filter @t4-code/mobile build:android:debug
```

The installable debug APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`.

A release build can be signed without committing credentials by setting all four variables before `pnpm --filter @t4-code/mobile build:android:release`:

```text
T4_ANDROID_KEYSTORE_PATH
T4_ANDROID_KEYSTORE_PASSWORD
T4_ANDROID_KEY_ALIAS
T4_ANDROID_KEY_PASSWORD
```

Without those variables Gradle still creates an unsigned release APK for CI inspection. The mobile shell deliberately has no Capacitor `server.url`; `cap sync` copies `apps/web/dist` into the native application.
