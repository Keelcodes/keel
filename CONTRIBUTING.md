# Contributing to Keel

Thanks for your interest in Keel. This project is early; the process below is
intentionally lightweight and will evolve.

## Ground rules

- Be respectful. See `CODE_OF_CONDUCT.md` (adopting Contributor Covenant).
- All contributions are accepted under the **Apache-2.0** license.
- Every commit must be **signed off** (`git commit -s`) to certify the
  [Developer Certificate of Origin](https://developercertificate.org/).

## Development setup

```bash
# Node.js >= 20, pnpm >= 9
pnpm install
pnpm build
pnpm test
pnpm typecheck
```

## Workflow

1. Open an issue describing the problem or proposal before large changes.
2. Fork the repository and create a topic branch.
3. Keep changes focused; one concern per pull request.
4. Add or update tests. New behavior without tests will not be merged.
5. Ensure `pnpm typecheck` and `pnpm test` pass locally.
6. Sign off your commits (`git commit -s`).
7. Open a pull request using the template.

## Scope

Keel deliberately **does not** re-implement account modules, bundlers or
paymasters. Contributions should compose existing standards and infrastructure.
Proposals that duplicate an existing, well-maintained implementation will be
redirected.

Out of scope (by design):

- Custodial wallet infrastructure
- Billing / subscription engines
- Multi-tenant SaaS control planes
- Proprietary account modules

## Commit messages

Use clear, imperative subject lines. Reference the relevant package if helpful,
e.g. `policy: enforce daily limit on-chain`.

## Code style

- TypeScript, strict mode.
- Formatting and linting are enforced by CI.
- Public APIs must be documented.

## Reporting issues

Use GitHub Issues. For security issues, follow `SECURITY.md` instead.
