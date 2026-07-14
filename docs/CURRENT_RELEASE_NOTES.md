## Immediate transcript images

T4 Code v0.1.13 pairs with an OMP runtime that projects verified image digests on the first live durable entry. Fresh transcript images render without restarting the appserver, and the same read path remains valid after reload or reconnect.

Managed RPC notifications now omit redundant inline image bytes while leaving OMP's durable session and model context unchanged. This keeps image-bearing lifecycle and entry frames under the one MiB child-line ceiling without discarding the image.

Tiny canonical image payloads are also persisted by content digest. Image prompts, bounded reads, animated-image controls, connection recovery, and session lifecycle controls from v0.1.12 continue unchanged.

## Runtime compatibility

T4 Code v0.1.13 vendors app-wire 0.5.5 from integration commit [6a87fa64](https://github.com/lyc-aon/oh-my-pi/commit/6a87fa6407ebff20417b4d52885a6bb3091003ea), source tree `a2495fe8781c979184fe7fb9a6d37d8f33bad30f`. Image prompts activate only when the host advertises the additive image capability; the compatibility handshake keeps older appservers available.

The matching OMP 16.5.1 runtime is built from [bed27ae6](https://github.com/lyc-aon/oh-my-pi/commit/bed27ae6e5658267745e2ec774e011fe7062e2f1) and tagged [t4code-16.5.1-appserver-6](https://github.com/lyc-aon/oh-my-pi/tree/t4code-16.5.1-appserver-6). It carries forward T4's appserver, lifecycle, upload, and transcript-read integration; bounds managed image notifications; restores live durable-entry projection; and persists tiny canonical images by verified digest.

The integration is based on the official upstream [v16.5.1 tag](https://github.com/can1357/oh-my-pi/tree/v16.5.1), commit [14b5da76](https://github.com/can1357/oh-my-pi/commit/14b5da76a9aece9a469288718d22c3d624daf033). Official upstream OMP v16.5.1 has no `appserver` command and cannot host T4 Code.

## Packages

The Android APK is signed and supports Android 7.0 or later. Linux packages target x86_64. macOS packages target Apple Silicon.

The macOS build is unsigned and unnotarized. Gatekeeper will block the first launch. After copying T4 Code to Applications, run:

```sh
xattr -dr com.apple.quarantine "/Applications/T4 Code.app"
```

Verify downloads with `SHA256SUMS.txt`.
