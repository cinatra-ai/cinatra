# Contributing to Cinatra

Thanks for your interest. Cinatra is the open source AI workspace, and external contributions — bug reports, agents, connectors, skills, documentation, and code — are welcome.

This page covers how to get a development environment running and how to propose changes. For the deeper architecture and authoring references, start at the [Developer Guide](https://docs.cinatra.ai/guides/developer/).

> **Cinatra is not production ready.** It is under active development and has not been hardened, security-audited, or stability-tested for production workloads. Treat it as evaluation, local development, and self-hosted experimentation software. APIs, schemas, and the extension contract may change without notice.

---

## Development setup

### Prerequisites

- **Node.js 24.x**
- **pnpm** (the repository pins its version; use `corepack pnpm`)
- **Docker** with Docker Compose, for the bundled PostgreSQL and Redis services
- **PostgreSQL** and **Redis** — supplied by the bundled Docker Compose stack, or point the app at your own instances

### First-time setup

```bash
git clone https://github.com/cinatra-ai/cinatra.git
cd cinatra
make setup
make dev
```

`make setup` installs dependencies, starts the supporting services, and configures the app. `make dev` brings the infrastructure up and starts the Next.js dev server. Open <http://localhost:3000>; the first user to register becomes the platform admin.

### Keeping your checkout up to date

After you pull new code, your local dependencies and dev database schema can fall behind it. Reconcile both with one command:

```bash
git pull
make refresh
```

`make refresh` is **dev-only** and **never touches git** — you manage branches, and it brings dependencies and the dev database in sync with the code on disk. It runs `pnpm install`, the idempotent dev setup (additive schema bootstrap and settings checks), and the versioned core schema migrations (node-pg-migrate modules in [`migrations/core/`](migrations/README.md), also applied automatically at app boot). If your change drops, renames, retypes, or otherwise destructively touches an existing core-store table, ship a migration artifact per [`migrations/README.md`](migrations/README.md). Restart with `make dev` afterward.

Other useful targets: `make check` (verify supporting services are reachable), `make down` (stop infrastructure, keep data), `make reset` (soft reset of app data), and `make logs` (tail infrastructure logs).

### Verifying the toolchain

```bash
pnpm typecheck      # fast type check
pnpm lint           # ESLint
pnpm build          # production build
```

A pull request should pass `pnpm typecheck` cleanly. Tests are package-local — run them with `pnpm --filter <package> test` where a package has them.

---

## Proposing changes

### Reporting bugs

Open a GitHub issue describing what you expected, what happened, a minimal reproduction, and your environment (Node, pnpm, Docker versions, and the commit you are on). For security issues, do **not** open a public issue — follow the private path in [SECURITY.md](SECURITY.md).

### Proposing features

Open a GitHub issue with the use case first. Describe the user problem and the shape of the solution so the design can be discussed before implementation. Large feature work without prior alignment tends to need significant rework.

### Submitting code

1. **Fork** the repository and create a branch off `main`.
2. Make your change in the smallest surface that achieves the goal. Bundle related changes; do not bundle unrelated ones.
3. Update or add documentation when the change affects what a user sees.
4. Add or update tests when you touch code that already has tests in its directory.
5. Open a pull request against `main`.

Pull request bodies should include a short **summary** (what changed and why), a **testing** note (how you verified it), and **screenshots** for UI changes. Wait for a maintainer review before merging.

### Commit style

- Write commit messages that explain the *why*, not just the *what*.
- Prefer atomic commits over large bundles.
- The default branch requires linear history; rebase rather than merge when updating a branch.

### Contributor agreement

No CLA or DCO sign-off is currently required. By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE), the same license as the Cinatra core.

---

## Where to ask questions

- **GitHub Issues** — bugs, feature requests, and design discussions
- **GitHub Discussions** (when enabled on the repository) — open-ended questions
- **Pull requests** — code changes
- **Private email** — security disclosures only, via [SECURITY.md](SECURITY.md)

We aim to triage issues and pull requests within a few business days.

---

## Code of Conduct

Participation in this project is governed by the [Code of Conduct](CODE_OF_CONDUCT.md). By taking part, you agree to uphold it.

---

## License

Cinatra core is licensed under the [Apache License 2.0](LICENSE). The WordPress and Drupal client integrations are distributed separately under GPL-2.0-or-later; the boundary between them is HTTP-only.
