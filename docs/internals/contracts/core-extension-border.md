# The core/extension border

The border between this host and the extension packs is strictly upheld. Ten lines
fix it, each one anchored in a contract this repository already carries.

1. **Core owns the lifecycle table and its only writer.** `packages/extensions/src/lifecycle-primitive.ts` — "`transitionExtensionLifecycle` is the ONLY function permitted to write `installed_extension.status`. Every code path … must call this primitive", and "the canonical-gate reach test enforces this by scanning for any direct .status write outside this module."
2. **Core owns the manifest schema; a pack owns the values in it.** `packages/sdk-extensions/src/manifest.ts` — "Per-extension manifest field schema. STATUS: ABI FROZEN. These fields live under the `cinatra` key of an extension's package.json."
3. **Identity is self-declared by the pack, and core keeps no roster.** The same file — "Vendor identity lives WITH the extension… The SDK owns NO authoritative vendor roster… never in the SDK and never at the host loader (which has no cross-vendor roster to check against)."
4. **Presence is generator-assigned, never inferred by hand.** The same file — the classification is "assigned by `scripts/extensions/generate-extension-manifest.mjs` on every emitted record and loader-map entry, never inferred from source shape."
5. **Pixels are the pack's; the ABI is core's.** `docs/internals/contracts/artifact-renderer-rsc-contract.md` — "the ADR fixes which side owns the pixels; this contract fixes the ABI those pixels are loaded and rendered against." A host MIME handler is the "core-owned never-blank FLOOR" under a pack renderer, never a replacement for one.
6. **Every passthrough admission is by name and by scope, and the scope comes from the run.** `src/lib/extension-scoped-tools.ts` — "EACH SCOPE IS DERIVED FROM THE RUN, NEVER FROM THE REQUEST… A request that names a package, a table outside the declaration, or a type outside the declared dependencies is refused with a stated reason — never widened", and "Every new admission on the passthrough is by name and by scope, never by wildcard."
7. **Pack source is materialized read-only and pinned, never authored here.** `scripts/ci/sync-dev-extensions.mjs` — "The bundled `extensions/…` source tree is not committed to this tree — it lives in the companion per-extension repos", checked out detached at the committed pin.
8. **Companion drift crosses only as a reviewable lock bump.** `docs/internals/contracts/extension-clone-pinning.md` — "companion drift lands as a deliberate, reviewable bump PR — never as spontaneous red", and the two locks are "a disjoint partition — never duplicate a pin."
9. **Gates are whole-suite and fail closed, so joining a check is the default.** The canonical extension invariants job "runs the WHOLE package … every carve-out is an explicit `exclude` entry … with a written reason and a filed follow-up issue"; host-side rules "DERIVE … from the LIVE kind-gates" (`scripts/extensions/lib/conformance-rules.mjs`), and pack source may not reach the filesystem directly (`scripts/audit/extension-fs-import-ban.mjs`).
10. **Therefore exactly four crossings are legitimate:** the lock re-pin written by the updater script; the materializer's generated alias and renderer maps; the display map resolving a DECLARED type to a DECLARED renderer slot; and a passthrough tool admitted by name whose scope is the caller's own declared dependency or declared table. Everything else crosses — a package-name branch, a pack's type id or physical table spelled in the host, a host-invented duplicate of a pack's declaration, a host-authored renderer for a pack's type, growth of a shrink-only legacy list, and a materialized pack file committed into this tree.

## How the border is enforced

`scripts/ci/core-extension-border-gate.mjs` scans the product code under `src/` and
`packages/` and reports each crossing with its file, its line and the rule it breaks.
Tests (also test helpers and stubs under `tests/` and `__stubs__/`), mocks, fixtures (the
`src/app/design-fixtures` tree included), generated maps and inventories, and type declarations
are outside the scan: a
pack name in a fixture is the fixture doing its job, and a pack name in a generated
map is the materializer crossing. Comments are masked before every scan, so a comment
that names a pack to explain a gap states knowledge without encoding it. The
materialized `extensions/` tree is never walked; it is a pack's own source at a pin.

`scripts/ci/core-extension-border-baseline.json` is the shrink-only ledger of the
crossings that stood when the gate landed. Each entry names one file and one detail
and states in one line why it stands; there is no wildcard, and an entry without a
stated reason fails the gate. A crossing outside the ledger fails immediately. A
`pack-shaped-core-domain` entry records the line count of every product file it
holds, so a new file inside it, or a recorded file above its recorded count, fails
too — the ledger may shrink and never grow. `config/skill-packaging-legacy-exceptions.json`
is held to the same rule: every entry it carries today is named in the ledger, so a
newly authored package cannot join it. The ledger is shrink-only as a FILE as well:
where the checkout can produce the ledger committed on the default branch, an entry it
gained, a recorded allowance it raised, or a file it newly recorded fails the gate, so a
crossing cannot be admitted by writing itself into the ledger alongside the code that
needs it. `--write-baseline` obeys the same rule: it lowers a recorded count, drops a
file that is gone and drops a spent entry, but it never raises a count and never writes
in a new file — it prints those instead, so growth stays a violation an author answers
for rather than a number that quietly moves.

A pack's identity is read from the two committed locks, widened two ways. A pack whose
package name carries a role suffix declares its types under the bare stem — the pack
`@cinatra-ai/email-artifacts` owns `@cinatra-ai/email:*` — so the type rule reads the
stem as well as the package name, and a restatement in core is not invisible merely
because the namespace is spelled shorter than the package. And a pack the ledger already
names stays in the universe after it leaves a lock, so a recorded crossing cannot be
silenced by unpinning the pack it names.

### `pack-slug-in-core` and `pack-slug-in-core-template-span` (cinatra#4531)

A pack is also named by its unscoped name, its leaf: `@cinatra-ai/openai-connector` is
`openai-connector`. Stage 1 of the rule reads the TypeScript and JavaScript source files of the
product tree (`.ts` `.tsx` `.mts` `.cts` `.js` `.jsx` `.mjs` `.cjs`) with the TypeScript parser and
takes the text of every string token: a `StringLiteral` in any quote (a JSX attribute value such
as `slug="openai-connector"` is one), a template literal without a substitution, and JSX text
trimmed. A declaration file (`.d.ts`, `.d.mts`, `.d.cts`) is not read, and neither is a fixture
or test helper module that stands in a product folder, by the names these modules have in the tree:
`fixtures.<ext>`, `conformance-fixtures.<ext>` and `testing.<ext>` (`dev-fixtures.ts`, the SDK's
fixture contract, is read). Each text is split on the
characters that separate the parts of a package reference as the product writes and parses it,
and each part is trimmed: `/ ? # = &` of a path or URL; `@` before a version range
(`@cinatra-ai/openai-connector@^0.1.0`, parsed by `packages/extensions/src/required-in-prod.ts`);
`:` before the type of a type id (`@cinatra-ai/<pack>:<type>`, parsed by
`packages/objects/src/claims.ts`); and `,` in a list of package names (parsed by
`src/lib/extension-auto-update.ts`). Whitespace is not a separator. Every part equal to a leaf is a
finding: the whole value `"openai-connector"`, `"/connectors/cinatra-ai/openai-connector/setup"`,
`"?q=openai-connector"`, `"openai-connector/index"`, and the leaf of a scoped name,
`"@cinatra-ai/openai-connector"` or `"@cinatra-ai/openai-connector/register"`, in a string or an
import specifier. One string can so be a finding of two rules, each recorded in its own ledger
entry: a scoped pack name is also a `pack-package-name-branch` finding, and a type id whose
namespace is the full package name is also a `pack-type-id-in-core` finding. Comments, regular
expressions and escapes are the parser's: a comment and a regular expression literal are not
string tokens and are not read. A file that does not parse fails the check with its name. The
vocabulary is the leaves of the pack universe above (the two committed locks, plus a pack the
ledger names); the check names no pack itself. A finding's detail is the leaf with its package,
`openai-connector (@cinatra-ai/openai-connector)`, and a repeated leaf in one file carries its
occurrence, as in the other text rules.

So that an ordinary word is never a finding, only a leaf that ends in a canonical kind suffix
is read, the suffixes the naming rule accepts
(`packages/extensions/src/__tests__/naming-conformance.test.ts`): `-agent`, `-assistant`,
`-connector`, `-artifact`, `-artifacts`, `-skill`, `-workflow`.

Stage 2 adds one position: the literal text spans of a template literal WITH a substitution, as
the parser gives them (the head, each middle and the tail, cooked), in an expression, a tagged
template or a template literal type. Its findings are recorded under their own rule id,
`pack-slug-in-core-template-span`, with the same detail and occurrence count: the ledger's base
guard never lets a rule it already ratchets gain an entry, so the wider reading enters as a new rule
seeded once, and the stage 1 entries stay shrink-only. Each span is split and judged as above, with
one difference: a span is a fragment, and its edge next to a substitution may continue into the
substituted value. A part of a span counts only when a separator of the rule or the outer end of
the whole template bounds it on both sides, never a substitution: `` `/api/${id}/openai-connector/run` ``
is a finding, `` `${prefix}openai-connector` `` and `` `openai-connector${suffix}` `` are not (a leaf
joined to a substitution is a stated limit). The tree held no finding of this position when it
landed, so the rule is seeded with no entry.

Not read in this stage (next stages, tracked in the issue): stylesheets, YAML, JSON, Markdown and
other run-time text files; JSX element and attribute names; root configuration files; regular
expression literals; a leaf inside a sentence or joined to other characters (`"use <leaf> now"`,
`"<leaf>-v2"`, `"<leaf>.json"`) or to a substitution (`` `${x}<leaf>` ``). Not part of this rule yet: the
role-suffix stem (`blog-content` of `blog-content-skill`) and a tool or table name under a pack's
stem.

### `unbounded-port-member` (cinatra#4872)

A host port member that takes a FREE NAME together with an UNTYPED PAYLOAD, the shape
`run(name: string, input: unknown)`, is a generic tunnel to any core behaviour. The rule
reads the type checker's resolved types, never how a type is written. A call signature has
the shape when one ordinary parameter is a free name and another ordinary parameter is untyped.
A free name is plain `string` (an optional `string | undefined`, `string & {}` and a type parameter
constrained to `string` count; a union of string literals does not) or an untyped parameter, which
is wider. Untyped is `any` or `unknown` (a union holding `unknown`, an unconstrained type parameter
and an implicit `any` count). So `run(a: unknown, b: unknown)` is reported, and a member with one
untyped parameter and no other free or untyped parameter, such as `emit(event: unknown)`, passes. Every overload is its own signature.

A finding is keyed `<context property>.<member>` (a member of an object member adds `.<sub>`):
the grant-visible port name the product itself uses (`HOST_PORT_NAMES`, `requestedHostPorts`),
for example `jobs.enqueue`. No type name is in a key and nothing is deduplicated: every context
property is walked on its own, so the same port type on two properties is two findings and two
ledger entries. A union context is walked per constituent; findings merge only when file and key
are string-equal. The anchor is the only place the rule names anything: the module
`packages/sdk-extensions/src/register.ts`, its export `ExtensionServerEntry`, the `register`
member, and the first parameter of its call signatures (the context). The program uses the
product's `tsconfig.json`. An unresolved type, a missing anchor, an untyped context and a context
written as a rest parameter ("the registration context is variadic; the border check cannot read
it") fail the check with a plain line.

A port member that needs a reported form is recorded with its reason.

Stated limits. Rest parameters are not read: a free name or an untyped payload passed through a
rest parameter (`...args`) is not found by this rule. A member typed `any` or `Function`, a name written as a template literal
(`` `job:${string}` ``) and an index signature are not this rule's business. A payload typed
`object`, `{}` or `Record<string, unknown>` is not untyped. Ports are read three levels deep (context
property, member, member of an object member); a port returned by a method, held in an array or
a `Map`, or found through an index signature on the context is not walked, and members declared in
the TypeScript library are skipped. The rule cannot tell a tunnel from a key-value store: `set<T>(key:
string, value: T)` is reported and recorded in the ledger. Hiding a tunnel on purpose behind
such a form is not blocked by this check.

### `single-package-declaration-reader` (cinatra#4873, stage 1)

A host reader of declarations takes them from the registry or from the manifests it iterates. A
module of core that value-imports one workspace package's per-primitive declaration array serves
that one package's domain. Stage 1 of the rule reads every product source file of the scan above
(a declaration file `.d.ts`, `.d.mts`, `.d.cts` imports nothing at run time and is not read, and
neither is a fixture or test helper module that stands in a product folder, by the names these
modules have in the tree, as for `pack-slug-in-core`: `fixtures.<ext>`, `conformance-fixtures.<ext>`
and `testing.<ext>`; `dev-fixtures.ts`, the SDK's fixture contract, is read) with
the TypeScript parser and takes each static import declaration with named imports,
`import { X } from "<specifier>"` and `import { X as Y } from "<specifier>"`. A named import is a
finding when the imported name (not the local name) ends with `PrimitiveMetadata`, the import is
not type-only (neither `import type { … }` nor an inline `type X`), and the package of the
specifier is not the package of the importing file. An import inside the declaring package is the
registering side and is allowed.

The package of a file is the directory `packages/<dir>` that holds it, or `src/` for the
application. The package of a specifier is decided from facts the tree states: a relative specifier
is resolved against the importing file and the package of the resolved path counts (so it stays
in the file's own package unless the path leaves it); a specifier that a path alias of the root
`tsconfig.json` matches is resolved through the alias's first target, an exact pattern before the
wildcard pattern with the longest prefix, as the compiler matches them (`@/x` is `src/`); a bare
specifier whose package name is a workspace package (the `name` of a `packages/<dir>/package.json`)
is that package; any other bare specifier is a package of its own. The rule names no package and no
primitive. A finding's detail is the imported name with the declaring package,
`xPrimitiveMetadata (@cinatra-ai/x)` (a workspace package's name, `src/`, or the bare package
name), and a repeated name in one file carries its occurrence. A file that does not parse fails the
check with its name. On the day the rule landed it had no finding, so its ledger holds no entry.

Not read in this stage (next stages, tracked in the issue): a re-export
(`export { xPrimitiveMetadata } from "…"`), a namespace import used by member access
(`import * as m` then `m.xPrimitiveMetadata`), a default import, a dynamic `import()`, `require`,
and an array re-exported under a name that does not end with `PrimitiveMetadata`. The issue's
other rule (`registry-word-in-core`: a registry key, a job name or a capability id that carries a
word derived from the locks, the SDK included) is a later stage. A reader that hides the import on
purpose behind one of these forms is not blocked by this stage.

## What the gate does not see

A text scan reads what is written, so the border rules find a crossing through the
thing that names a pack: a physical table prefix, a declared type id, a package name,
a tool name. A duplicated declaration that keeps no such anchor — a bare value
restated as a host constant — is indistinguishable from any other constant and is not
caught; review carries that case. A name assembled at run time rather than written —
`"ext_" + "cinatra_ai_" + suffix`, or a package name built by concatenation — is not a
written name and is not caught; the rules read literals. A comment written inside a
template expression is kept rather than masked, which can only ever report a crossing
that is not one, never hide one. The line-count ratchet on a pack-shaped core module
is a size ratchet, not a content one: a module may be edited inside its recorded size,
and the text rules still run over every file inside it. A tree missing either committed
lock is refused rather than scanned, because an empty pack universe would turn the type
id and passthrough rules off without saying so — and each lock must name at least one
package, so one lock cannot cover for an empty other. A missing ledger is refused for
the same reason: an absent ledger is not an empty one. The ledger-growth check needs the
default branch in the checkout; where a shallow clone cannot produce it, the check is
skipped and the named-and-justified rules still stand.

The gate runs as part of the packages/extensions suite
(`packages/extensions/src/__tests__/core-extension-border.test.ts`), which the
canonical extension invariants job runs whole — so a border regression fails a
required check. Run it directly with
`node scripts/ci/core-extension-border-gate.mjs` (add `--report` to list every
crossing, ledger entries included).
