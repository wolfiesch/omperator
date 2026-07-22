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
- Published macOS builds are signed with Apple Developer ID and notarized by Apple. Reports of certificate, Team ID, hardened-runtime, timestamp, Gatekeeper, or stapled-ticket drift are security-relevant.
- Starting with v0.1.24, the release workflow requires the pinned Developer ID identity, hardened runtime, Apple notarization, a stapled ticket, and a successful Gatekeeper assessment before publishing macOS artifacts.
