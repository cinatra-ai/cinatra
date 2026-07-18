# In-repo engineering documentation (`docs/internals/`)

Documentation for people (and coding agents) hacking on Cinatra itself —
architecture notes, contracts the code enforces, decision records, and
governance records. It is **not** product documentation: user, admin, hosting,
and developer guides live at [docs.cinatra.ai](https://docs.cinatra.ai)
(source: [cinatra-ai/docs](https://github.com/cinatra-ai/docs)).

Machine-consumed config/data (inventories, manifests, matrices) is **not**
documentation and lives under [`config/`](../../config/).

## Layout (by nature, not by topic)

| Directory | What lives here |
|-----------|-----------------|
| [`architecture/`](./architecture/) | System shape and subsystem boundaries (e.g. the skills lifecycle, the stateful-service inventory). |
| [`decisions/`](./decisions/) | ADRs / decision records — point-in-time rulings with status and rationale. |
| [`contracts/`](./contracts/) | Invariants the code enforces (extension server-entry contract, clone pinning, library closure, widget source of truth, LLM-provider dependency vocabulary, moderation credentials, default-off flags, the artifact-renderer RSC contract). |
| [`workflows/`](./workflows/) | Authoring / process guidance (webhook authoring and delivery, the upgrade track, the run-scoped HITL prompt prep-node + resume-mutation pattern). |
| [`governance/`](./governance/) | Living policy: ownership, decision process, gate policy. |
| [`records/attribution/`](./records/attribution/) | Attribution / gate correction records (append-only; `Correction-for:` trailers reference commit SHAs, not paths). |
| [`records/audits/`](./records/audits/) | Release and audit records. |

Conventions:

- **Append-only records** (`records/**`) are historical — do not edit them;
  add a new record instead.
- New engineering docs go in the subdirectory matching their **nature**
  (a contract the code enforces vs. a decision vs. a process guide), not a
  per-feature folder.
- PR render/screenshot evidence never goes in the product tree — commit it
  to an evidence branch and link it by commit-SHA permalink.
