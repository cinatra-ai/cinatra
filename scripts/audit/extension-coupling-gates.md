# Extension-coupling audit gates — classification, exemption policy, counts

This document is the reference the three extension-coupling gates point at. It
defines the shared reference taxonomy, the strict exemption policy, and the
current per-gate counts with their end-state targets. Update the counts table
whenever a baseline is legitimately regenerated.

## The gates

| Gate | Direction | Unit | Baseline |
| --- | --- | --- | --- |
| `core-extension-instance-coupling-ban.mjs` | core (`src/` + `packages/`) naming a specific extension (string/JSX/prompt/metadata literal, path literal, or import) | `file :: kind :: value -> count` occurrences | `core-extension-instance-coupling-ban.baseline.json` |
| `core-extension-import-ban.mjs` | core (`src/`) importing an extension package | `file -> extension` edges | `core-extension-import-ban.baseline.json` |
| `extension-import-ban.mjs` | extensions importing host `@/` modules, other extensions, or non-SDK first-party packages | `extension -> module` edges in 3 dimensions | `extension-import-ban.baseline.json` |

`discovery-dispatcher-bypass-ban.mjs` is the precedent for the
sanctioned-allowlist shape used below (its reader/barrel/handler facet
allowlist is "sanctioned, never counted" — distinct from the baseline).

All baselines are no-new-rot ratchets: they may only ever SHRINK. The single
sanctioned exception is a scanner-correctness recompute of the
instance-coupling baseline, gated by `SCANNER_EPOCH` (see below).

## Reference classification (shared taxonomy)

Defined in `scripts/audit/lib/extension-reference-classification.mjs` and used
by all three gates:

- **runtime-coupling** — core selects/loads/branches on a specific extension
  at runtime (named imports, loader maps, provider registration,
  prompt/dispatch literals). The default class; removed by the runtime
  decoupling work.
- **mechanical** — re-export facades, hand-written inventories/catalogs,
  dev-name lists, and generated *derivatives* of the manifest. Counted and
  ratcheted exactly like runtime-coupling — never exempt; removed/consolidated
  by the mechanical-cleanup pass.
- **permanent-exempt** — never counted. Strict, owner-ruled set; see below.

## Strict exemption policy

Permanently exempt are ONLY:

1. **The generated extension manifest** — `src/lib/generated/extensions.server.ts`.
   It is the legitimate data-driven install list; names there are generator
   output, not hand-coupling. Deliberately narrow: the *other* generated files
   (`src/lib/generated/connector-setup-pages.ts`, `extensions.client.tsx`) are
   derivatives, not the manifest, and are counted as `mechanical`.
2. **The documented data-contract-ID allowlist**
   (`DATA_CONTRACT_ID_ALLOWLIST`) — stable string identifiers that embed an
   extension name as a frozen serialization/compatibility contract, NOT as
   runtime selection. Every entry must carry a written justification (the gate
   hard-fails on an unjustified entry), entries are added only with an owner
   ruling, stale entries hard-fail until removed, and allowlisted occurrences
   are reported separately from counted ones. IDs may contain ONLY the
   boundary alphabet `[A-Za-z0-9_.:/@-]` (`DATA_CONTRACT_ID_ALPHABET_RE`) —
   enforced as a structural defect — so the exact-ID masking can never
   prefix-mask a longer ID past a non-alphabet character. Currently EMPTY.
3. Test files (`*.test.*`, `*.spec.*`, `__tests__/`, `__mocks__/`, `tests/`)
   and the `extensions/` tree itself (an extension naming itself is fine).

No facades, no inventories, no dev-name lists are exempt — they are counted
(`mechanical`) and driven to zero like everything else.

Known, documented divergence: `core-extension-import-ban.mjs` still
file-exempts all of `src/lib/generated/**`. Narrowing it would grow that
baseline (forbidden); the instance-coupling gate already counts those files'
references, so nothing goes unmeasured. The same applies to the sibling
scanners' older comment-stripping (see next section): correcting them would
also grow their baselines, so their correction lands with a later legitimate
recompute, while the fixed instance-coupling scanner already counts every
reference (imports included) across both `src/` and `packages/`.

Known, documented residual lexer limitation: JSX TEXT is not modeled by
`lib/strip-comments.mjs` (that needs a JSX-aware parser), so a named-extension
reference appearing in JSX text AFTER a bare non-URL `//` on the same line
would be under-counted. No such case exists in the tree (the recomputed
baseline shows zero decreases vs the old scanner); the class is an explicit,
non-silent deferral tracked on cinatra-ai/cinatra#26 and closes with a
JSX-aware lexer in a later scanner epoch.

## Scanner correctness + the corrected baseline

The instance-coupling scanner previously stripped comments with a regex pair
that was not lexical-context aware. Two failure classes hid real references:

- a `/*` inside a line comment (e.g. a doc note mentioning `@/lib/*`) opened a
  bogus block comment that swallowed all following code until the next `*/` —
  this hid the whole static import cluster of
  `src/lib/register-transport-connectors.ts` and the live setup-page loader
  map of `src/lib/connector-setup-pages.ts`;
- a `//` inside a string literal swallowed the rest of that line.

The fix is the shared single-pass lexer `scripts/audit/lib/strip-comments.mjs`
(line/block comments, strings, template literals with interpolation, regex
heuristic). The recomputed baseline after the fix is a one-time RISE — the
scanner stopped hiding references — sanctioned by bumping `SCANNER_EPOCH` (1 →
2) in `core-extension-instance-coupling-ban.mjs`. The committed baseline's
`scannerEpoch` must match the script's; growth vs the base ref is allowed only
when the epoch advanced by exactly 1 in the same change, so the allowance
self-expires on merge. From the corrected baseline onward, shrink-only holds.

## Current counts and end-state targets

Counts as of the epoch-2 recompute (verify with the commands below):

| Gate | Before | After (corrected baseline) | End-state target |
| --- | --- | --- | --- |
| `core-extension-instance-coupling-ban` | 224 keys / 282 occurrences / 108 files | **279 keys / 349 occurrences / 112 files** — runtime-coupling 287 occ (108 files), mechanical 62 occ (4 files), allowlisted 0 | **0** counted occurrences (manifest + justified data-contract-ID allowlist only) |
| `core-extension-import-ban` | 96 edges / 49 files | **96 edges / 49 files** (unchanged — no growth permitted; all runtime-coupling) | **0** edges |
| `extension-import-ban` | 20 `@/` + 0 cross-extension + 0 sdkOnly | **20 + 0 + 0** (unchanged; all runtime-coupling; sdkOnly already zero-tolerance in CI) | **0 + 0 + 0** |

The instance-coupling rise decomposes as: +18 occ
`src/lib/connector-setup-pages.ts` and +12 occ
`src/lib/register-transport-connectors.ts` (un-hidden by the lexer fix), +8
occ `packages/agents/vitest.config.ts` (glob strings had opened bogus block
comments), +29 occ `src/lib/generated/connector-setup-pages.ts` (strict
exemption narrowing — generated derivative now counted as mechanical).

"Is the cutover done?" therefore has an exact answer: all three baselines at
zero, with the only remaining named-extension references living in
`src/lib/generated/extensions.server.ts` and the justified
data-contract-ID allowlist.

## Reproduction

```sh
# current state (all should pass / print the counts above)
node scripts/audit/core-extension-instance-coupling-ban.mjs
node scripts/audit/core-extension-import-ban.mjs
node scripts/audit/extension-import-ban.mjs --strict-sdk-only

# with the CI monotonic base-ref guard
CORE_EXT_INSTANCE_BAN_BASE=origin/main node scripts/audit/core-extension-instance-coupling-ban.mjs
CORE_EXT_BAN_BASE=origin/main node scripts/audit/core-extension-import-ban.mjs
IMPORT_BAN_BASE=origin/main node scripts/audit/extension-import-ban.mjs --strict-sdk-only

# regenerate a baseline after legitimate decoupling work (shrink-only)
node scripts/audit/core-extension-instance-coupling-ban.mjs --write-baseline
```

The extension source tree must be cloned back first
(`node scripts/ci/sync-dev-extensions.mjs`) or the gates fail closed.
