# macOS signing and notarization

T4 Code distributes its Mac build directly through GitHub Releases. It does not use the Mac App Store. Starting with v0.1.24, the protected release workflow must sign the application with Apple Developer ID and submit it to Apple's automated notarization service before publication.

```text
source tag
    |
    v
protected macOS runner
    |
    +-- imports the encrypted Developer ID certificate
    +-- builds with hardened runtime
    +-- signs every application component
    +-- submits the app to Apple notarization
    +-- staples Apple's ticket
    +-- builds the DMG and ZIP
    +-- reopens both artifacts and checks their identity
    v
release artifacts
```

## Public identity contract

`.github/macos-release-identity.json` pins the bundle ID, Apple Team ID, Developer ID certificate, target architecture, and first signed release. The release inspector extracts the leaf certificate from the built application and compares its SHA-256 fingerprint with that contract.

Certificate rotation is a deliberate release change. Create the replacement certificate first, update the public identity contract, verify a dry-run build, and only then replace the GitHub secret. Do not silently accept any valid Developer ID certificate.

## GitHub Actions secrets

The repository uses these encrypted secrets:

| Secret | Purpose |
| --- | --- |
| `T4_MACOS_CERTIFICATE_BASE64` | Base64-encoded password-protected Developer ID `.p12` bundle |
| `T4_MACOS_CERTIFICATE_PASSWORD` | Password for the `.p12` bundle |
| `T4_APPLE_API_KEY_BASE64` | Base64-encoded App Store Connect `.p8` key used for notarization |
| `T4_APPLE_API_KEY_ID` | App Store Connect API key ID |
| `T4_APPLE_API_ISSUER_ID` | App Store Connect API issuer ID |
| `T4_APPLE_TEAM_ID` | Apple Developer team identifier |

Secrets are available only to the protected release job. Pull requests and ordinary CI keep using dependency-free checks and never receive Apple credentials.

## Local commands

### Flutter migration development

Flutter macOS `Debug` builds deliberately omit Keychain Sharing so contributors can build and run
the app without joining the Apple Developer team:

```bash
pnpm dev:flutter -- -d macos
```

These builds use a process-local credential store and show an **Unsigned development** strip.
Saved host metadata remains available, but paired device credentials are never written to disk and
must be paired again after the app exits. `Profile` and `Release` use separate entitlements that
retain Keychain Sharing and therefore require Apple development signing. Never add a plaintext
fallback, remove the warning, or remove Keychain Sharing from the signed configurations.

Signed Flutter milestone artifacts must be produced by a protected maintainer workflow or signing
machine. Contributors do not need the certificate, provisioning profile, or Apple team membership
to run those artifacts.

### Released Electron application


Contributors can build the released Electron application without Apple credentials:

```bash
pnpm package:mac:unsigned
```

Maintainers can produce the release form when the five electron-builder credential variables are present:

```bash
CSC_LINK=/path/to/certificate.p12 \
CSC_KEY_PASSWORD='...' \
APPLE_API_KEY=/path/to/AuthKey.p8 \
APPLE_API_KEY_ID='...' \
APPLE_API_ISSUER='...' \
pnpm package:mac
```

Do not put these values in `.env` files, shell history, source control, build logs, or issue reports.

## Verification boundary

`scripts/inspect-macos-release.mjs` reopens the ZIP and mounts the DMG read-only. For the application inside each artifact it verifies:

- the complete code signature;
- the exact bundle ID and Apple Team ID;
- the pinned leaf-certificate SHA-256 fingerprint;
- the Developer ID certificate chain;
- hardened runtime and a secure timestamp;
- a valid stapled notarization ticket; and
- acceptance by macOS Gatekeeper.

The first signed release remains a manual GitHub download. Automatic macOS updates are a separate follow-up because migration from the older unsigned build must be tested independently.
