# Security Policy

## Supported versions

Keel is pre-alpha. Until a stable release, only the `main` branch is supported.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Report privately via GitHub Security Advisories ("Report a vulnerability") on
`keelcodes/keel`, or by email to `security@keel.codes`.

Include, where possible:

- A description of the issue and its impact
- Steps to reproduce, or a proof of concept
- Affected package(s) and version/commit
- Any suggested mitigation

We aim to acknowledge reports within a few business days.

## Scope

Keel handles authorization and payment flows for autonomous agents. Areas of
particular interest:

- Session-key / policy bypass (off-chain checks skipped; on-chain limits not
  enforced)
- Signature validation flaws in ERC-7579 validators
- Paymaster / bundler relay abuse
- Migration tooling that silently leaves an account in a broken state
- Key handling in reference implementations

## Design commitments

- **On-chain enforcement**: spend limits must be enforced on-chain, not only by
  client-side pre-checks.
- **No silent failure**: module installation and session state must be
  verifiable (e.g. `isModuleInstalled` + `isInitialized` probes).
- **No plaintext key storage** in reference implementations.

See `docs/THREAT_MODEL.md` for the full threat model.
