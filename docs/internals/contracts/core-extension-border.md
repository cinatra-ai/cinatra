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
Tests, mocks, fixtures, generated maps and type declarations are outside the scan: a
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

### `unbounded-port-member` (cinatra#4872)

A host port member that takes a FREE NAME together with an UNTYPED PAYLOAD, the shape
`run(name: string, input: unknown)`, is a generic tunnel through which any core
behaviour can be reached. The rule reports a member when one of its call signatures
has a parameter of the plain `string` type and another parameter of type `any` or
`unknown`. It reads the type checker's resolved types, never how a type is written:
a union holding plain `string` (also `"a" | (string & {})`) is free, a union of string
literals is bounded; a type parameter counts by its constraint (none or `unknown` is
untyped, `string` is a free name). Every overload is its own signature and is read.
A signature is read as a list of ALTERNATIVE parameter lists, and a member is reported
when any alternative has the shape. Fixed parameters are one list; a `this` parameter is
not a parameter. A rest parameter gives one alternative per constituent of its type: a
union of tuples one per tuple, a generic rest (`...args: A`) through its constraint, a
tuple its elements (named or not, optional included), an array `T[]` zero or more `T`,
where `T` fills both positions only when `T` itself can be a free name and untyped
(`string | U` for a type parameter `U`; `string | unknown` is `unknown` and is not).

A finding is the port as the extension reaches it, and the member, keyed
`<Port>.<member>` (the ledger's detail; the file is the member's declaration). The port
is the type of a context property, split per constituent of a union or intersection (a
type parameter through its constraint), and named by the declaration the checker
resolves, never by an alias: an alias of an interface or class is that interface or
class, and `Port<A>` and `Port<B>` are the one declared port `Port`. A literal type is
named by the alias that declares it; an anonymous one (inline, or a generic alias) by
the context property that exposes it. So the same port type on two context properties is
one finding; a different port type that inherits the member (`DerivedPort extends
HostJobsPort`) is its own finding, `DerivedPort.enqueue`, and a new entry for the
ledger. Nothing is skipped for having been seen before. Two different port declarations
that would be reported under one key (two `JobsPort` from different modules, two inline
ports on a property of the same name in a union context) cannot be told apart by the
ledger, so the check fails with a plain line: rename one of them.

The anchor is the only place the rule names anything: the SDK registration module
`packages/sdk-extensions/src/register.ts`, its export `ExtensionServerEntry` and that
type's `register` member. The first parameter of `register` (aliases and re-exports
followed) is the context; its members are the ports, and their own, non-private members
are read. The program uses the product's `tsconfig.json`. An unresolved type, or a
missing anchor, fails the check with a plain line.

Stated limits. A member typed `any` or `Function` is not this rule's business; port
shapes are issue #4932. A name typed `any`, a template literal (`` `job:${string}` ``)
or an index signature (`[name: string]: (input: unknown) => void`) is not a plain
`string` parameter and is not reported. A payload typed `object`, `{}` or
`Record<string, unknown>` is not untyped for this rule. Ports are read two levels deep
(context member, then its members); a port returned by a member or held in an array is
not walked. The rule cannot tell a tunnel from a logging sink or a key-value store: a
member such as `set<T>(key: string, value: T)` is reported and is recorded in the ledger.

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
