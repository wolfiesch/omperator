## Image prompts and transcript images

T4 Code v0.1.12 can attach up to eight PNG, JPEG, WebP, or GIF images to one prompt, with a 20 MiB limit per image. Drafts remain local until the host accepts them, and interrupted or uncertain sends stay recoverable instead of being silently discarded.

Transcript images are loaded by verified digest through bounded work queues and per-session caches. Animated images include pause and play controls, and T4 follows the device's reduced-motion preference.

## Connection recovery

Desktop, browser, and Android transports now stop waiting and reconnect when a host accepts a socket but does not complete setup. T4 first advertises image support and performs one compatibility retry without that feature when an older host rejects the handshake.

## Runtime compatibility

T4 Code v0.1.12 vendors app-wire 0.5.5 from integration commit [6a87fa64](https://github.com/lyc-aon/oh-my-pi/commit/6a87fa6407ebff20417b4d52885a6bb3091003ea), source tree `a2495fe8781c979184fe7fb9a6d37d8f33bad30f`. Image prompts activate only when the host advertises the additive image capability; the compatibility handshake keeps older appservers available.

The matching OMP 16.5.1 runtime is built from [6a87fa64](https://github.com/lyc-aon/oh-my-pi/commit/6a87fa6407ebff20417b4d52885a6bb3091003ea) and tagged [t4code-16.5.1-appserver-4](https://github.com/lyc-aon/oh-my-pi/tree/t4code-16.5.1-appserver-4). It carries forward T4's appserver and lifecycle integration, adds bounded prompt-image uploads and transcript-image reads, and tightens public wire decoding, typed command results, canonical response boundaries, and RPC event limits.

The integration is based on the official upstream [v16.5.1 tag](https://github.com/can1357/oh-my-pi/tree/v16.5.1), commit [14b5da76](https://github.com/can1357/oh-my-pi/commit/14b5da76a9aece9a469288718d22c3d624daf033). Official upstream OMP v16.5.1 has no `appserver` command and cannot host T4 Code.

## Packages

The Android APK is signed and supports Android 7.0 or later. Linux packages target x86_64. macOS packages target Apple Silicon.

The macOS build is unsigned and unnotarized. Gatekeeper will block the first launch. After copying T4 Code to Applications, run:

```sh
xattr -dr com.apple.quarantine "/Applications/T4 Code.app"
```

Verify downloads with `SHA256SUMS.txt`.
