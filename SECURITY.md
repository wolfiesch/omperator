# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |
| Anything older | No |

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report privately through **GitHub private vulnerability reporting**: [Report a vulnerability](https://github.com/LycaonLLC/t4-code/security/advisories/new).

Include what you can:

- The affected version and platform.
- Steps to reproduce, or a proof of concept.
- What an attacker gains.
- Redacted logs only. Never include tokens, pairing codes, credentials, or other people's data.

We read every report and will reply to tell you what happens next. This is a small project; we don't promise a fixed response time, but private reports get looked at before anything else.

## Scope notes

- T4 Code is a desktop client. The OMP runtime is a separate project; runtime vulnerabilities belong at <https://github.com/can1357/oh-my-pi>.
- Pairing credentials are encrypted with the OS keychain via Electron `safeStorage`. Reports about credential handling, the pairing flow, or the `t4-code://` deep-link handler are especially welcome.
- The macOS v0.1.13 build is unsigned and unnotarized; that is a known, disclosed limitation, not a vulnerability report. Removing `com.apple.quarantine` changes Gatekeeper handling but does not sign, notarize, or verify the app.
