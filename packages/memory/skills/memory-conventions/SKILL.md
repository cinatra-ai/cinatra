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

The command surface comes from the `@cinatra-ai/memory` workspace package. No
subcommand makes a model call. Every subcommand except `sync` is also local and
offline; `sync` is the one that talks to a Cinatra server.

| Command | Use it for |
|---------|------------|
| `memory init` | Create a bundle and its stable identity. |
| `memory add --type <kind> --title <t>` | Author one concept. |
| `memory list [--type <kind>] [--json]` | See what the bundle already holds. |
| `memory recall <query> [--json]` | Lexical search before you act or write. |
| `memory check [--json]` | Conformance diagnostics; non-zero on an error. |
| `memory sync [--dry-run] [--json]` | Push the bundle into shared memory. |

Every subcommand takes `--dir <bundle-dir>`. Omit it to use the nearest
`.memory/bundle.yaml` at or above the working directory.

`memory sync` is one-way. It writes local concepts into shared memory and never
edits a concept file or `bundle.yaml`, never deletes a remote row, and never
narrows one. Run `memory sync --dry-run` first: it prints the create / update /
skip decision for every concept and writes nothing. The endpoint comes from
`--url` or `CINATRA_MCP_URL` and must be `https` unless it is a loopback host;
the credential comes from `CINATRA_MCP_TOKEN` only, so it never reaches your
shell history. The server re-derives every rule for itself, so a concept it
refuses is refused for a reason your bundle cannot override.

A sync run that wrote something leaves one file behind: `sync-ledger.json` at
the bundle root. It records the object id and content digest of what the last
run pushed, which is how a later run reports a row that drifted since. **Do not
commit it.** It is a per-checkout cache, the object ids in it are minted per
organization by whichever server answered, and nothing reads it as authority —
the preflight decides what to write, and the ledger only reports disagreement.
`memory init` writes a `.gitignore` next to it that already excludes it; a
bundle created before that line needs the entry added by hand.
<!-- memory-conventions:end -->

## Installing this skill

Copy this directory to `.claude/skills/memory-conventions/` in the project, or
to `~/.claude/skills/memory-conventions/` for every project. Another
tool-calling host reuses the same text: the block above names no
Claude-specific tool and no Claude-specific file layout.
