# Product

## Register

product

## Users

T4 Code is for expert developers and maintainers who run OMP across Linux and macOS workstations. They move between projects, long-lived sessions, subagent trees, terminals, files, and code reviews while work is actively streaming. They need fast situational awareness, exact runtime state, and safe control without losing session context.

## Product Purpose

Provide one desktop observability and control surface for OMP sessions, subagents, command execution, files, terminals, and reviews while OMP remains the runtime and configuration authority. Success means a user can discover local or paired hosts, resume the right session, understand current work, intervene safely, and survive disconnects or restarts without duplicate output, hidden state, or terminal scraping.

## Flagship Workflow: Agent Operations Center

Agent View is T4 Code's primary operational workspace for concurrent OMP work. It provides one global, hierarchy-preserving view across loaded sessions, with compact health summaries, attention triage, search, bounded pagination, and direct navigation into the selected agent's session detail. Session-local panes remain the place for focused transcript and control work; Agent View is where an operator finds the right work and decides where to intervene.

The control center must remain useful from a few agents through large agent fleets. Rendering stays bounded, parent context remains visible around filtered descendants, every action resolves against current runtime authority, and phone-sized layouts retain the same search, triage, inspect, and control affordances.

## Brand Personality

Precise, capable, calm — with a wink in the name. T4 Code is the product; Oh My Pi is the runtime it fronts, and the interface says so plainly where hierarchy helps (onboarding, about, empty welcome). It should carry the confidence and interaction quality of a mature developer tool: dense when the work demands it, quiet when it does not, and unmistakably OMP through the exact pi/plugin mark and restrained Pi Pink identity details. The T4 name is a deliberate nod to its T3 interaction reference; the UI never fakes T3 branding.

## Anti-references

- Generic AI workflow dashboards, oversized metric cards, decorative agent graphs, or chat toys.
- T3 Code's cloud, Clerk, relay, billing, or provider assumptions; T3 is an interaction and visual reference, not a product model.
- Broad accent washes, pink or orange warning semantics, warm cream or paper themes, glass-card monoculture, gradient text, fake grain, turbulence, or sketch effects.
- Permanent dashboard side panes, modal-first workflows, noisy auto-opening panels, or decorative continuous motion.
- Terminal scraping, renderer-owned runtime truth, hidden duplicate settings stores, or interactive input into an agent-owned shell.

## Design Principles

1. **Runtime truth stays visible.** Distinguish durable OMP state, live activity, cached projections, reconnecting state, and unknown outcomes instead of smoothing them into false certainty.
2. **Continuity beats spectacle.** Preserve session, draft, scroll, panel, terminal, and replay context across A-B-A switching, disconnects, and restarts.
3. **Dense, not cluttered.** Use familiar developer-tool affordances, strong hierarchy, and progressive disclosure so expert detail is close without turning every surface into a dashboard.
4. **Attention is earned.** Keep the right pane closed by default, use badges for passive changes, and interrupt only for user input, approval, plan review, or a real safety boundary.
5. **Control is explicit.** Show host, capability, lease, confirmation, and revision scope at the point of action; remote access and destructive commands never inherit trust silently.

## Accessibility & Inclusion

Target WCAG 2.2 AA for text, controls, focus, and non-text contrast. Every workflow must be keyboard-operable with predictable focus restoration and visible focus rings. Support light and dark themes, reduced motion, 200% text, narrow windows, high-DPR displays, screen-reader live regions, color-blind-safe semantic states, CJK/RTL/emoji content, and deterministic bundled font metrics. Motion conveys state only and has an instant or crossfade reduced-motion path.
