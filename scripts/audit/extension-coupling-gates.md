# Extension-coupling audit gates — classification, exemption policy, counts

This document is the reference the three extension-coupling gates point at. It
defines the shared reference taxonomy, the strict exemption policy, the
zero-tolerance enforcement model (cinatra-ai/cinatra#36 — the closing
phase of the IoC Runtime Cutover epic #24), and the pinned per-gate floors.
Update the floor table whenever a baseline legitimately shrinks.

## The gates

| Gate | Direction | Unit | Baseline |
| --- | --- | --- | --- |
| `core-extension-instance-coupling-ban.mjs` | core (`src/` + `packages/`) naming a specific extension (string/JSX/prompt/metadata literal, path literal, or import) | `file :: kind :: value -> count` occurrences | `core-extension-instance-coupling-ban.baseline.json` |
| `core-extension-import-ban.mjs` | core (`src/`) importing an extension package | `file -> extension` edges | `core-extension-import-ban.baseline.json` |
| `extension-import-ban.mjs` | extensions importing host `@/` modules, other extensions, or non-SDK first-party packages | `extension -> module` edges in 3 dimensions | `extension-import-ban.baseline.json` |

`discovery-dispatcher-bypass-ban.mjs` guards the runtime-discovery dispatcher
(its documented `SANCTIONED_READERS` allowlist is "sanctioned, never counted" —
distinct from the baseline, which is pinned EMPTY since the flip — cinatra#36).

## Enforcement model — ZERO-TOLERANCE (cinatra#36)

All baselines are FROZEN RESIDUAL FLOORS: they may only ever SHRINK, by any
mechanism. Concretely, for the coupling gates:

- any reference/edge NOT in the committed baseline fails CI immediately;
- the committed baseline may never grow vs the base ref (monotonic guard,
  fail-closed on unresolvable refs);
- `--write-baseline` REFUSES to write a grown baseline (remove the coupling
  instead of re-baselining it);
- the instance-coupling gate's `SCANNER_EPOCH` growth allowance is RETIRED —
  the epoch is frozen at 2 and survives purely as a tamper check (committed
  epoch must equal the script's and the base ref's; any mismatch fails). A
  scanner fix that reveals previously hidden references must land WITH those
  references fixed in the same PR;
- the import-ban gate's one-PR `NEWLY_UNEXEMPTED_BASELINE_SEED` transition is
  RETIRED — un-exempting a connector requires removing its edges in the same
  PR;
- the discovery-bypass baseline is PINNED EMPTY: a non-empty committed
  baseline is itself a failure, and any non-sanctioned direct-reader
  reference fails immediately;
- `extension-import-ban.mjs` runs `--strict-sdk-only` in CI (the precedent zero-tolerance flip for the `sdkOnly` dimension; its
  `STRICT_SDK_ONLY_ALLOWLIST` is EMPTY); its `hostInternal`/`crossExtension`
  dimensions remain shrink-only floors.

Changing any of this requires editing the gate code and its tests in a
reviewed PR — there is no data path (baseline, epoch, seed, regenerate) that
can raise a floor.

## Reference classification (shared taxonomy)

Defined in `scripts/audit/lib/extension-reference-classification.mjs` and used
by all three gates:

- **runtime-coupling** — core selects/loads/branches on a specific extension
  at runtime (named imports, loader maps, provider registration,
  prompt/dispatch literals). The default class; everything still counted is
  in this class (see the residual floor register below).
- **mechanical** — re-export facades, hand-written inventories/catalogs, and
  dev-name lists. Counted and ratcheted exactly like runtime-coupling — never
  exempt. The mechanical-cleanup phase (#35) drove this class to ZERO occurrences; any reappearance is a
  NEW key and hard-fails.
- **permanent-exempt** — never counted. Strict, owner-ruled set; see below.

## Strict exemption policy

Permanently exempt are ONLY:

1. **The generated manifest tree** — the exact files
   `scripts/extensions/generate-extension-manifest.mjs` emits (the shared
   `GENERATED_MANIFEST_FILES` list: `extensions.server.ts`,
   `connector-setup-pages.ts`, `extensions.client.tsx`,
   `widget-stream-public-paths.ts` under `src/lib/generated/`). Names there
   are generator output — the legitimate data-driven install list, not
   hand-coupling. The owner ruling on #36 made the whole generated tree
   the ONE permanent-exempt class (the sibling generated maps are part of it,
   not a separate concession), unifying the instance-coupling and import-ban
   exempt sets. Two integrity guards keep the exemption honest:
   - the exemption is an EXPLICIT file list, never a directory prefix — a
     hand-added extra file under `src/lib/generated/` is counted (default
     class runtime-coupling → NEW key → hard fail);
   - the listed files are pinned to the generator's byte-exact output by the
     FAIL-CLOSED `generate-extension-manifest.mjs --check` CI step (drift,
     missing file, or catalog-parity break fails CI).
2. **The documented data-contract-ID allowlist**
   (`DATA_CONTRACT_ID_ALLOWLIST`) — stable string identifiers that embed an
   extension name as a frozen serialization/compatibility contract, NOT as
   runtime selection. Every entry must carry a written justification (the gate
   hard-fails on an unjustified entry), entries are added only with an owner
   ruling, stale entries hard-fail until removed, and allowlisted occurrences
   are reported separately from counted ones. IDs may contain ONLY the
   boundary alphabet `[A-Za-z0-9_.:/@-]` (`DATA_CONTRACT_ID_ALPHABET_RE`) —
   enforced as a structural defect — so the exact-ID masking can never
   prefix-mask a longer ID past a non-alphabet character. Currently EMPTY —
   nothing in the residual floor is a data-contract ID (the nango facade is
   an import, not an ID), so no entry was minted for the zero-tolerance flip (#36).
3. Test files (`*.test.*`, `*.spec.*`, `__tests__/`, `__mocks__/`, `tests/`)
   and the `extensions/` tree itself (an extension naming itself is fine).

No facades, no inventories, no dev-name lists are exempt — they are counted
(`mechanical`) and hard-fail as NEW keys if they ever reappear.

Known, documented residual lexer limitation: JSX TEXT is not modeled by
`lib/strip-comments.mjs` (that needs a JSX-aware parser), so a named-extension
reference appearing in JSX text AFTER a bare non-URL `//` on the same line
would be under-counted. No such case exists in the tree. Since the zero-tolerance flip (#36) there is
no epoch-recompute path: if a future JSX-aware lexer reveals references, they
must be fixed in the same PR that lands the lexer (the floor cannot rise).
The same applies to the sibling scanners' older comment-stripping: a stripping
correction that would reveal edges must land with those edges removed.

## Pinned floors (the #36 end-state)

Recorded at the flip (#36; verify with the commands below); floors may only
move DOWN. The epic's journey: the corrected epoch-2 baseline started at 349
occurrences / 96 import edges; the decoupling phases (#27–#35) drove it to the floor below; the flip (#36)
pinned it.

| Gate | Pinned floor (current) | Direction |
| --- | --- | --- |
| `core-extension-instance-coupling-ban` | **120 occurrences / 52 files** — ALL runtime-coupling; mechanical 0; data-contract allowlisted 0 (at the flip, #36: 166/128/81; −5 occ Ops, −9 occ Content, −17 occ LLM slices — Plan-B lazy/guarded cutover, cinatra#7; −15 occ nango serverEntry cutover, cinatra#151 Stage 1) | shrink-only, frozen |
| `core-extension-import-ban` | **0 edges / 0 files** — the value-import surface is fully RETIRED (at the flip, #36: 41/28; −4 Ops, −8 Content, −19 LLM — Plan-B lazy/guarded cutover, cinatra#7; −10 nango — the serverEntry cutover, cinatra#151 Stage 1, closing the #35 facade residual). The committed baseline is EMPTY; the pinned-empty gate flip rides the transport-blind-spot closure (cinatra#151 Stage 3) so the flip is honest under the shared lexer. | shrink-only, frozen |
| `discovery-dispatcher-bypass-ban` | **0 files** (5 documented sanctioned readers, justified in-gate) | PINNED EMPTY |
| `extension-import-ban` | **19 `@/` + 0 cross-extension + 0 sdkOnly** (sdkOnly zero-tolerance in CI, allowlist EMPTY; nango's github-api reachback retired by the cinatra#151 companion — its remaining database/linkedin/wordpress fallback edges retire with the companion sweep) | shrink-only |
| `host-peer-value-import-ban` | **0** | hold at 0 |

"Is the cutover done?" has an exact answer: the gates can no longer move
backward, the exempt set is the only sanctioned coupling, and the residual
floor below is the remaining (frozen, tracked) decoupling debt.

## Residual floor register (what the 166 occ / 41 edges ARE)

The IoC cutover epic (#24) removed the gate's *tolerance* for coupling; it
deliberately did NOT remove these residual clusters, which are out of the
epic's scope and tracked elsewhere:

- **The `src/lib/nango.ts` facade — RETIRED (cinatra#151 Stage 1).** The
  serverEntry cutover landed the ratified inverse direction: the connector's
  `register(ctx)` registers the full `nango-system` capability surface
  (config-store + blocking-materializer inversion in the companion); the
  host resolves it in `src/lib/nango-system.ts` (fail-loud default, the
  pinned auth boot read degraded per the design's item 9a); the facade is
  DELETED, all former consumers (routes, pages, `ctx.nango`, packages)
  re-pointed; `register-transport-connectors.ts` dropped its 15-name nango
  import block and keeps publishing `@cinatra-ai/host:nango-connection-storage`
  as a thin delegating adapter (old-id retirement rides the transport-DI
  cutover, cinatra#151 Stage 3). Floors moved: `core-extension-import-ban`
  10 → 0 edges, instance-coupling 135 → 120 occ, root connector deps 1 → 0,
  declarations 16/16 unchanged (nango moved from hard-imported + root-dep to
  generated-required in the cover gate). The companion sweep (removing the
  connector's skew-window `@/lib` fallbacks) is the named follow-up.
- **The host's eager connector value-import surface** — at the flip, 11
  unique connector packages still value-imported by `src/` (anthropic,
  apollo, blog, crm, email, gemini, nango, openai, social-media, tailscale,
  twenty: campaign actions, configuration/setup pages, the transport
  registration legacy cluster, background jobs, blog/email surfaces), with
  ~20 concrete connector packages still hard `workspace:*` deps of the root
  package.json — this is prod-bootability **Plan B** territory
  (cinatra-ai/cinatra#7): making these imports lazy/guarded and the generated
  maps presence-aware so `requiredExtensions` can shrink from the 33-package
  bootable set toward the ~8 true system packages. Explicitly out of epic
  #24's scope (its scope boundary says so). Plan B's presence-aware
  generated-maps slice is LANDED: the generated tree now carries generator-owned
  `resolution: "required" | "guardedOptional"` metadata on every loader
  entry (keyed on `cinatra.systemExtensions`; missing/unknown counts as
  required, fail-closed), guardedOptional loaders route through the
  standardized degraded-result guard (`src/lib/extension-load-guard.ts`),
  and the maps are regenerated at every consuming surface (`make setup`
  dev path + the prod image build stage, with `--check --self` as the
  non-canonical self-check mode). Floors UNCHANGED by that slice (enabler; the
  generated tree is the exempt class). The 41→10-edge shrink retired
  the non-nango `src/` value-import surface (cinatra#7); the dep-drop slice then (a) taught the cover
  gate (`required-extensions-cover-host-imports.mjs`) the guarded-optional
  class — a generated-map package classified `guardedOptional` (and proven
  degradable by the generated test) is ACQUIRABLE-ON-DEMAND, no longer
  bootable; missing/unknown classification stays required, fail-closed — and
  (b) DROPPED the 19 non-nango root `workspace:*` connector deps (20 → 1;
  resolution rides the tsconfig path aliases, the mechanism the six already
  root-dep-free connectors proved through dev + prod-image builds). The
  cover gate also adopted the shared lexical stripper
  (`lib/strip-comments.mjs`), closing its `@/lib/*` blind spot: the HONEST
  hard-import surface (src/ + packages/, generated tree excluded) is **9
  packages** — nango (the #35 facade residual; implementation now tracked by
  cinatra-ai/cinatra#151) + openai, anthropic,
  gemini (packages/llm provider adapters + the transport DI cluster),
  drupal-mcp, wordpress-mcp (transport DI cluster), crm, gmail,
  google-calendar (packages/agents single-function edges). The bootable
  floor is therefore **16** (8 `systemExtensions` + those 8 hard-wired
  packages), not ~8: the 16→8 tail is exactly the three deferred cutovers
  (LLM-provider extensibility; the drupal/wordpress content-editor MCP DI;
  the packages/agents picker/action edges) — tracked on cinatra#7.
- **The statically-wired transport DI cluster** —
  `src/lib/register-transport-connectors.ts` still value-imports the
  LLM-platform connectors (openai `/deps`, anthropic) and the
  drupal/wordpress content-editor MCP connectors for `register<X>Connector(deps)`
  binding; its header documents this as explicitly out of the
  transport-registration cutover's scope ("until their own cutover phase").
  KNOWN SCANNER LIMITATION: these edges are currently INVISIBLE to the
  import-ban scanner — the file's header contains a literal `@/lib/*` whose
  `/*` the legacy comment-stripper treats as a block-comment opener, swallowing
  the import section (the documented stripping-limitation class above).
  Exactly FOUR hidden edges remain (openai `/deps`, anthropic, drupal-mcp,
  wordpress-mcp) — the nango edge in this file was REMOVED by the cinatra#151
  Stage 1 authorship transfer (the 15-name import block is gone). They
  ARE counted by the instance-coupling gate (`package ::` keys for that file
  in the committed baseline), and since the dep-drop slice (cinatra#7) they ARE counted by the
  required-extensions COVER gate (which adopted the shared lexer — it is
  live-coverage, not baseline-ratcheted, so the correction needed no edge
  removal there and closes a real under-coverage hole the dep drop would
  otherwise have opened). Per the policy above, the IMPORT-BAN stripper
  correction must land WITH these edges removed — i.e. with the
  LLM-platform/content-editor DI cutover (cinatra#151 Stage 3), not before.
- **The literal tail** — agent-renderer registration maps
  (`packages/agents/src/register-default-renderers.ts` and the per-renderer
  files), a2ui adapter agent IDs, telemetry/logging provider catalogs, seed
  workflows, and dev tooling globs. Each is a real named-extension reference
  in core; each shrinks only by genuine decoupling work.

Every cluster lives in the committed baselines — visible, counted, and
incapable of growing.

## Scanner correctness (historical)

The instance-coupling scanner previously stripped comments with a regex pair
that was not lexical-context aware; the shared single-pass lexer
`scripts/audit/lib/strip-comments.mjs` fixed two failure classes that hid
real references (a `/*` inside a line comment swallowing following code; a
`//` inside a string swallowing the line). The recomputed baseline after the
fix was a one-time RISE sanctioned by bumping `SCANNER_EPOCH` 1 → 2 in the
same PR. The zero-tolerance flip (#36) FROZE the epoch at 2 and retired the growth allowance: from the
flip onward, shrink-only holds unconditionally and the epoch is a pure tamper
check.

## Reproduction

```sh
# current state (all should pass / print the pinned floors above)
node scripts/audit/core-extension-instance-coupling-ban.mjs
node scripts/audit/core-extension-import-ban.mjs
node scripts/audit/discovery-dispatcher-bypass-ban.mjs
node scripts/audit/extension-import-ban.mjs --strict-sdk-only
node scripts/extensions/generate-extension-manifest.mjs --check   # fail-closed integrity of the exempt generated tree

# with the CI monotonic base-ref guard
CORE_EXT_INSTANCE_BAN_BASE=origin/main node scripts/audit/core-extension-instance-coupling-ban.mjs
CORE_EXT_BAN_BASE=origin/main node scripts/audit/core-extension-import-ban.mjs
DISCOVERY_BYPASS_BASE=origin/main node scripts/audit/discovery-dispatcher-bypass-ban.mjs
IMPORT_BAN_BASE=origin/main node scripts/audit/extension-import-ban.mjs --strict-sdk-only

# regenerate a baseline after legitimate decoupling work (REFUSES growth)
node scripts/audit/core-extension-instance-coupling-ban.mjs --write-baseline
```

The extension source tree must be cloned back first
(`node scripts/ci/sync-dev-extensions.mjs`) or the gates fail closed.
