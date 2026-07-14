# Contributing to T4 Code

Thanks for helping. This page covers setup, checks, and what a good report or PR looks like.

## Setup

Needs Node `^24.13.1` and pnpm `11.10.0`.

```sh
git clone https://github.com/LycaonLLC/t4-code.git
cd t4-code
pnpm install
pnpm dev
```

## Before you open a PR

Run the gate locally:

```sh
pnpm check   # release contract, provenance, lint (warnings denied), typecheck
pnpm test    # workspace tests
```

Both must pass. If your change touches packaging, also run `pnpm test:packaging`.

## What we look for in a PR

- One change per PR. Small diffs get reviewed fast; grab-bags don't.
- Say what the change does and how you verified it. "Ran X, saw Y" beats "should work."
- Match the code around you. Don't add a second way to do something that already has one.
- New behavior needs a test that fails without the change.
- Ports from T3 Code or OMP source must follow the provenance rules in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md): separate import and adaptation commits with a provenance record.

## Logs and secrets

When you attach logs (issues or PRs), **redact them first**:

- Never paste API keys, tokens, pairing codes, or credentials of any kind.
- Strip usernames, home paths, hostnames, and project names you don't want public.
- Appserver logs live in `~/.local/state/t4-code/appserver` (Linux) or `~/Library/Logs/T4 Code/appserver` (macOS). Trim them to the relevant window.

We will close reports containing live secrets and ask you to rotate them.

## Reporting bugs

Use the [bug report template](https://github.com/LycaonLLC/t4-code/issues/new/choose). Version, OS, install method, and steps to reproduce matter more than prose.

**Security problems are different: never open a public issue.** See [SECURITY.md](SECURITY.md).

## License

By contributing you agree your work is licensed under the project's [MIT license](LICENSE).
