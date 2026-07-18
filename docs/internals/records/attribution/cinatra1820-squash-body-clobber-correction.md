# Squash-body correction — cinatra#1820 / #1708 (L1 byte-level artifact integrity)

## What

The squash commit for PR #1820 (`0df473849234690a5a5e53f7b38c1c666da32b1d` on
`main`) landed with a **correct subject, diff, and verification trailers** but a
**wrong descriptive body**. The body text describes a different, unrelated change
(`package.json#cinatra.artifact` object-type declaration for the marketing-icp
pack, epic #1785) and carries a false `Part of cinatra#1785` cross-reference.

The commit's **actual** diff is what its subject says: L1 declared-environment
**byte-level artifact integrity in the build recipe key** —
`packages/execution-plane/src/environment/{builder,recipe}.ts` + tests. It is
**Part of #1708** (exec-plane S3, slice C — the byte-identity direction of AC1),
and consumes/links nothing in #1785.

## Cause

A shared-scratchpad collision. The `--body-file` handed to `gh pr merge --squash`
was overwritten, between the moment it was written and the moment `gh` read it,
by a concurrently-running sibling lane (the #1785 marketing-icp lane) writing its
own squash body to the same non-unique scratchpad path. `gh` therefore read the
sibling's body. The subject was passed inline (`--subject`) and was unaffected,
which is why the subject correctly names #1708 while the body names #1785.

## Verification (the landed diff is the intended one)

```
git show --stat 0df473849234690a5a5e53f7b38c1c666da32b1d
# packages/execution-plane/src/environment/builder.ts   | 162 +++--
# packages/execution-plane/src/environment/recipe.ts     |  78 ++--
# packages/execution-plane/src/index.ts                  |   1 +
# packages/execution-plane/src/__tests__/*               | (byte-integrity tests)
```

No `package.json#cinatra` / marketing-icp file is touched. The
`truthful-attribution-gate` on the merged SHA is green: the `Assisted-by`,
`Gate-suite: cinatra-core@2026.07.5`, and `Accountable` trailers are all correct
and truthful, and the merged tree binds to the reviewed head. Only the
human-readable prose body and its `Part of` reference are wrong.

## Correction

This docs-only forward correction is the durable record. The authoritative
description of `0df473849234690a5a5e53f7b38c1c666da32b1d` is:

> **feat(execution-plane): exec-plane S3 — L1 byte-level artifact integrity in
> the build recipe key (Part of #1708).** Bind package-manager artifact byte
> integrity (apt `.deb` SHA256, pip install-report artifact sha256, npm global
> content hash) into the L1 environment build recipe key, so a byte-differing
> artifact at the same resolved version busts the cache key (#1708 AC1
> byte-identity direction). `resolvedArtifacts` becomes
> `manager → { resolved, integrity }`; builder version bumped `/1 → /2`;
> real-daemon E2E is slice D. **Part of #1708** — not #1785.

The `Part of cinatra#1785` line in the merged body does **not** associate this
execution-plane change with #1785; that cross-reference is spurious.

**Lesson (enforced going forward):** a squash `--body-file` must live at a
per-PR-unique path (never a shared, reused scratchpad filename), because sibling
lanes run steady-state against the same scratch tree and a plain `squash-body.txt`
is a race target.
