---
name: memory-conventions
description: Use when a coding agent has a persistent Memory bundle (an OKF 0.1 `.memory/` directory) available and needs the conventions that govern reading and writing it. The conventions cover what qualifies, the frontmatter type choice, the duplicate check, the credential prohibition, and recall before acting. Read them before the first write of a session.
---

# memory-conventions

## Purpose

Route a coding agent to the conventions that govern a Memory bundle, and give
it the commands it needs to read one.

## The block

Everything between the markers below is generated from the conventions page and
must not be edited here. Regenerate it with
`MEMORY_SEED_WRITE=1 pnpm --filter @cinatra-ai/memory test`.

<!-- memory-conventions:begin -->
> When your host has given you a Memory bundle, you have persistent memory:
> read its `index.md` first, and recall from the bundle before you act. A
> repository bundle sits at `.memory/`, and `--dir <bundle-dir>` reaches one
> that lives elsewhere. Write one concept file per durable insight, and read
> the memory conventions before your first write. Where no bundle is present
> yet, `memory init` creates one, and these conventions govern it from its
> first concept.

The conventions behind that pointer have exactly one authority. This block
carries the pointer and routes for the rest. In a Cinatra checkout, read
`docs/internals/workflows/memory-conventions.md`. It covers what qualifies as a
concept, one concept per insight, the frontmatter `type` choice, the duplicate
check against `index.md`, the credential prohibition, and recall before acting.

The same rules ship as concepts in the seed bundle
`packages/memory/seed/conventions`, so an agent with no checkout reads them
through the CLI instead: `memory list --dir <seed-bundle>` and
`memory recall --dir <seed-bundle> <query>`.

The command surface comes from the `@cinatra-ai/memory` workspace package.
Every subcommand is local, offline, and free of model calls.

| Command | Use it for |
|---------|------------|
| `memory init` | Create a bundle and its stable identity. |
| `memory add --type <kind> --title <t>` | Author one concept. |
| `memory list [--type <kind>] [--json]` | See what the bundle already holds. |
| `memory recall <query> [--json]` | Lexical search before you act or write. |
| `memory check [--json]` | Conformance diagnostics; non-zero on an error. |

Every subcommand takes `--dir <bundle-dir>`. Omit it to use the nearest
`.memory/bundle.yaml` at or above the working directory.
<!-- memory-conventions:end -->

## Installing this skill

Copy this directory to `.claude/skills/memory-conventions/` in the project, or
to `~/.claude/skills/memory-conventions/` for every project. Another
tool-calling host reuses the same text: the block above names no
Claude-specific tool and no Claude-specific file layout.
