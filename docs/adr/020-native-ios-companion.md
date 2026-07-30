# ADR 020: Native iOS is a companion; Electron remains the desktop product

- Status: accepted for integration proof; not shipped.

## Context

Omperator currently ships Electron with the canonical React renderer as its
desktop application. iPhone and iPad access use the responsive Tailnet client.
The native SwiftUI work adds an iOS client, a hand-written Swift port of the T4
host wire, and a macOS target built from the same source tree.

Merging those sources without defining their roles would create two apparent
desktop products and let their behavior, release processes, and user
expectations drift.

## Decision

The native iOS application is a candidate first-class companion for an existing
T4 host. It never embeds or replaces OMP or `t4-host`. OMP remains authoritative
for runtime and durable session truth, while the client projects host frames and
sends capability-gated commands.

Electron and the canonical React renderer remain the primary desktop product.
The Swift macOS target is an integration and parity harness. It is not shipped
and does not imply a desktop cutover. Replacing Electron would require a
separate architecture and release decision.

The Swift `HostWire` port mirrors the TypeScript wire contract rather than
becoming a second protocol authority. Changes to the shared wire must select
both TypeScript and Swift verification.

## Release boundary

Source presence, simulator screenshots, and a successful compile are not an iOS
release. Before the native companion can ship, an exact candidate must prove:

- fresh-install pairing through the intended Tailnet route;
- Keychain-backed credential restoration without logging wire payloads;
- background, foreground, reconnect, and host-restart behavior;
- session inventory, attach, prompt, plan/question, cancellation, and paging;
- files, terminal, agent, notification, and preview behavior;
- prompt/controller lease transfer between desktop and iPhone; and
- signed distribution, update, privacy, and release metadata appropriate to the
  selected Apple distribution channel.

Until those proofs pass and a release publishes the native artifact, public
documentation continues to say that no native iOS application is shipped.
