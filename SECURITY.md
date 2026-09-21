# Security Policy

## Scope

FLETCH is a read-only intelligence layer: it reads Robinhood Chain state
through RPC/Blockscout and never holds funds, signs transactions, or exposes
a private key or custodial path. There is no execution path in this
repository (see the README). That materially limits the blast radius of a
bug here, but three classes of issue still matter and are in scope:

- A crafted RPC response, event log, or API input causing incorrect risk/
  score output that could mislead a user into a bad trade
- A way to make the API (`src/api/server.ts`) crash, leak another caller's
  data, or execute arbitrary code
- Exposure of `.env` secrets (`BLOCKSCOUT_API_KEY`, `RPC_URL`) through logs,
  error responses, or the dashboard

Out of scope: issues that require an already-compromised RPC endpoint,
denial-of-service that just needs raw request volume, or "the score
disagrees with my opinion of a token" (open a normal issue for that instead).

## Reporting a Vulnerability

Please **do not** open a public GitHub issue for a security report.

Use **[GitHub Security Advisories](https://github.com/leopardracer/FLETCH/security/advisories/new)**
for this repository — it's private between you and the maintainer until a
fix ships. Include:

- The affected file/endpoint and, ideally, a minimal repro
- What real-world impact you'd expect (misleading score? crash? secret
  exposure?)
- Whether it needs a live RPC connection to trigger, or reproduces against
  the deterministic test suite

You should get an initial response within 5 business days. If a report is
confirmed, a fix is prioritized ahead of feature work and credited in the
advisory (unless you'd rather stay anonymous) once it ships.

## Supported Versions

FLETCH is pre-1.0 (`0.x`). Only the `main` branch is supported — there are
no maintained release branches to backport a fix to yet.
