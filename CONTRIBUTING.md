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

**No credential is ever left behind in your checkout.** The knowledge-graph indexer gets its provider key through the environment of the `docker compose` command that creates it, so `docker/graphiti/.graphiti.env` is **never present** and nothing under `docker/` may contain a key-shaped value — a CI gate fails the build if it does. There is nothing to delete after a dev session. See [`docs/internals/contracts/no-provider-key-at-rest.md`](docs/internals/contracts/no-provider-key-at-rest.md).

### Development server memory

`pnpm dev` bounds the development server's V8 heap at 8192 MB
(`--max-old-space-size=8192` in the `dev` script), and the framework restarts the
server process when, after a request, more than 80 % of the heap limit is in use.
The process still grows far past that bound, because most of what it holds is
outside the heap: the bundler runs natively inside the same process, and with
`--enable-source-maps` Node.js keeps the source maps of the loaded server code in
memory. Three development servers of this repository (Next.js 16.2.10 on Linux
machines with 62 GB each, read from each process's `/proc/<pid>/status`)
measured:

| Age of the process | Anonymous memory | File-backed | Swapped out |
|---|---|---|---|
| 44 min | 14.1 GB | 0.1 GB | 0 |
| 64 min | 16.4 GB | 0.1 GB | 1.9 GB |
| 77 min | 19.6 GB | 0.1 GB | 4.9 GB |

Two such processes fill a 62 GB machine to the point of swapping, which slows
every page and every end-to-end step.

- **The memory line.** Once a minute the development server writes one line to
  its log, for example
  `[dev-memory] rss=5234MB heapUsed=1234MB heapTotal=1400MB external=210MB arrayBuffers=35MB`:
  `process.memoryUsage()` in whole megabytes of 1024 × 1024 bytes. What `rss`
  holds beyond `heapTotal` and `external` is native memory, mostly the bundler.
  `rss` does not count memory that was swapped out. Filter the log with
  `grep -F '[dev-memory]'`. Only the development server writes this line.
- **`CINATRA_DEV_SOURCE_MAPS=0`** starts the server process without
  `--enable-source-maps`, which `next dev` adds otherwise. Set it in the shell or
  in `.env.local`. Unset or empty keeps the default; any other value stops
  `pnpm dev` with an error that names the variable. With source maps off, stack
  traces from server code can point into the compiled output instead of your
  source files.

The bundler's own memory has no working limit in this framework version.
Next.js 16.2.10 accepts `experimental.turbopackMemoryLimit` (in bytes), but its
native side takes the value and does not use it, and the production-build
measurements in
[Building cinatra on a memory-constrained host](docs/internals/workflows/constrained-host-builds.md)
found it inert, so this checkout does not set it. To raise the heap bound, start
the launcher with your own options, for example
`NODE_OPTIONS='--disable-warning=DEP0169 --max-old-space-size=12288' node scripts/dev-server.mjs`.
Stopping the server (`pnpm dev:stop`) gives all of its memory back.

### Verifying the toolchain

```bash
pnpm typecheck      # fast type check
pnpm lint           # ESLint
pnpm build          # production build
```

`pnpm build` is memory-hungry: the measured minimum is **16 GiB available to the
build**, and the build prints a loud warning when it has less. If it dies on your
machine, read
[Building cinatra on a memory-constrained host](docs/internals/workflows/constrained-host-builds.md)
— it documents that floor and the four runs behind it, the `CINATRA_BUILD_BUNDLER`
/ `CINATRA_BUILD_CPUS` knobs (also available as `docker build --build-arg`), and
the measured numbers for the settings that do not help.

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
