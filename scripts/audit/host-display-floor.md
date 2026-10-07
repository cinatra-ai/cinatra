# Host display floor — the application's own artifact displays (cinatra#3821)

An artifact extension declares the type and draws it from its content. The
application keeps the generic roads. Where the application still draws an
artifact's content itself — for one content form (markdown, plain text, the
download card) or for one type — or draws one agent's step itself, that code
is a **floor**: it may shrink, and it may never grow. cinatra#3319 empties the
content-form part of it.

Two classes of the border hold this, beside the sibling gates of
[extension-coupling-gates.md](extension-coupling-gates.md):

| Class | What it refuses | Where |
| --- | --- | --- |
| 7 — the application's own displays are a closed floor | a new host handler kind or review form, a new host display module, a new host renderer for one step, a host display or step renderer that grows (a new top-level declaration or a new value import) | `host-display-floor-gate.mjs`, its baseline `host-display-floor-gate.baseline.json`, and the test of record in `__tests__/host-display-floor-gate.test.mjs` |
| 8 — an extension's display outranks the host's own on every surface | a dispatch function that returns a display of the host's own where an extension's display is registered, for the artifact's type or for its representation; a dispatch value of the host's own chosen outside the dispatch; a new site of the review's host form mount | the test of record in `__tests__/extension-display-precedence.test.mjs`; the sections `mimeConstructions` and `hostMounts` of the same gate |

Both tests of record run in the root suite (`pnpm test:root`, the job
"Perpetual core invariants (loops, ratchets, unit tiers)"), so they run on
every pull request of the application.

```
node scripts/audit/host-display-floor-gate.mjs                  # check (exit 0 clean, 1 findings, 2 scanner error)
node scripts/audit/host-display-floor-gate.mjs --write-baseline # ratchet the floor down
HOST_DISPLAY_FLOOR_BASE=<ref> node scripts/audit/host-display-floor-gate.mjs   # also refuse a floor grown against <ref>
```

A scanner error (exit 2) is never a pass: a module the derivation needs is
absent, a type it reads cannot be resolved, or a file does not parse.

## The dispatch model

One function, `buildDispatchModel`, derives the model with the TypeScript
type checker. The gate's command line and both test files call it; nothing
copies it. The program is rooted at `src/app/artifacts/[id]/renderer-dispatch.ts`
and `src/lib/artifacts/artifact-review-preparation.ts`, with the compiler
options of the repository's `tsconfig.json` (`noEmit`, `skipLibCheck`). Its
compiler host reads the application's own files and TypeScript's lib files
only: never a file under `extensions/` and never a third-party file under
`node_modules/`.

- **The dispatch type** is the type alias `ArtifactRenderDispatch` of the
  dispatch module.
- **The host members** are its members whose `kind` is not an extension's
  display (every member other than `semantic` and `representation`; today
  `mime`, `requires-rebuild` and `fallback`).
- **The host handler kinds** are the string-literal members of `handler` on the
  member whose kind is `mime`.
- **The review's host forms** are the string-literal members of `form` on the
  `ReviewTargetMount` member whose kind is `form`.
- **The representation patterns** class 8 drives are the media types the host's
  own `pickHandler` compares, read from the module that declares the handler
  kind union; when none is left, the one pattern `text/markdown`.

A declaration the model cannot find is a scanner error that names it. The one
exception: when the `mime` member or the `form` member is gone altogether, the
closed list has nothing to read — its entries are stale and ratchet down to
none, and the OK line says "no host handler kind".

## The sections of the floor (class 7 and the static half of class 8)

The scan reads `src/` and every `packages/*/src`.

- **`handlerKinds`** — the closed list: one key `dispatch :: <kind>` per host
  handler kind and `review-form :: <form>` per review form. A new member fails.
- **`displays`** — the modules where the application draws an artifact's
  content itself. A module M is a host display when
  - (d1) M lies under `src/app/artifacts/[id]/handlers/`; or
  - (d2) a **dispatch consumer** (a module that imports a value or a type from
    the dispatch module, or the type `ReviewTargetMount` from the review
    preparation module) mounts a JSX component imported from M inside a
    **host branch** — a `case` of a switch on a property `kind`, `handler` or
    `form`, labelled with a host member's kind, a host handler kind or a review
    form (an empty `case` falls through to the next); or the then-block of an
    `if` whose condition calls a function with an argument that is a property
    access named `objectType` — directly, through a same-module `const`
    initialized with that JSX, or through a same-module function component the
    branch mounts, one level deep; AND no module other than the dispatch
    consumers and the handlers directory imports M (shared chrome, such as the
    page layout, is never a display); AND no dispatch consumer also mounts M's
    component outside every dispatch branch (the page's own chrome, such as the
    read-denied panel drawn before the dispatch, is never a display).
- **`stepRenderers`** — the entries of the object literal whose keys
  `knownFieldRendererKinds()` in `packages/agents/src/register-default-renderers.ts`
  returns, whose `renderer` is a component of the host's own: imported from a
  module other than the never-blank schema floor (`./schema-field-renderer`).
  Key `<kind> :: <module>`. A new kind with a component of the host's own
  fails; a kind moved onto the schema floor is stale.
- **`ceilings`** — every module of `displays` and `stepRenderers` carries two
  measures: `topLevel`, its count of top-level value declarations (functions
  with a body, classes and variable declarations, exported or not), and
  `imports`, the sorted set of its value-import specifiers (static imports,
  re-exports, side-effect imports and literal dynamic `import()`; `import type`,
  `export type` and imports whose bindings are all type-only are skipped; a
  relative or `@/` specifier is normalized to its repository path without
  extension, a package specifier is kept as written). A count above the
  ceiling or a specifier not in the set is refused; a lower count or a
  specifier no longer imported is stale. A display that reaches new code grows,
  wherever the new code is placed; a fix inside an existing declaration does
  not.
- **`mimeConstructions`** — an object literal whose `kind` is the string
  literal `"mime"` in any module other than the one that declares the dispatch
  type: a display of the host's own chosen outside the dispatch. Pinned empty.
- **`hostMounts`** — an object literal with `kind: "form"` and an `arm` that is
  the literal `"first-party"` or a value passed through (the arm's type holds
  that one literal today): the review's host form mount, counted per module.

**Exempt:** tests, specs, `__tests__`, `__fixtures__`, stories,
`.d.ts`, the generator-emitted files (`PERMANENT_EXEMPT_FILES` of
`lib/extension-reference-classification.mjs`) and `src/app/design-fixtures/`.

## Class 8, the test of record

`__tests__/extension-display-precedence.test.mjs` enumerates, through the type
checker, every function exported by the dispatch module whose return type (a
Promise unwrapped) is the dispatch type. The first parameter must be declared
with the type `ArtifactRenderDispatchInput`; every further parameter must be a
finite union of literal types and is driven with every member. In every
dispatch consumer, a function with that return type that is not an export of
the dispatch module fails the test by its module and name, unless it only
returns a call of an enumerated function (a caller that delegates is covered
through the function it calls). An exported dispatch function with more than
one call signature (overloads) fails the test by name, because one signature's
parameters are not the domain of the others. A component mounted in a host
branch whose relative or `@/` module cannot be resolved is a scanner error.

Each enumerated function is driven with two cases, with names outside the
organisation:

- **CASE TYPE** — an extension's display is registered for the artifact's type
  (a built semantic renderer of the type's own extension), with no
  representation, with every host handler kind as a first-party default, and
  with another package's built representation provider. The result must be
  that semantic display.
- **CASE REPRESENTATION** — an extension's display is registered for the
  representation (a built provider for every representation pattern), for a
  row with no primary extension and for an extension type that ships no
  semantic renderer. The result must be that representation display.

Any other result — a display of the host's own above all — fails with the
function, the case, the pattern and the parameter values in its message.

## How the floor moves

The mechanics are the sibling gates' own (`vendor-token-core-gate.mjs`):

- a new key or a grown count is refused;
- a key whose count fell, or whose module is gone, is **stale** and fails until
  `--write-baseline` ratchets it down;
- `--write-baseline` refuses to write a grown floor, carries every owner by
  key, and writes a new key with owner `UNASSIGNED`;
- the check fails on an entry whose owner is empty or `UNASSIGNED` — each entry
  names the extension that will own the code, or the item that takes it over
  (`removedBy` on a display);
- `HOST_DISPLAY_FLOOR_BASE=<ref>` fails closed on a flag-like or unresolvable
  reference and refuses a committed floor that grew against the base; it
  imposes nothing when the base holds no baseline (the introducing change).

A change that removes a display (cinatra#3319 for the content forms) reads
stale entries in every section it empties and ratchets them down with
`--write-baseline` in the same change. The class 8 test needs no host member:
it stays green when the host's own displays are gone.

## The one double reading

The `topLevel` measure of `packages/agents/src/blog-idea-selection-renderer.tsx`,
`campaign-recipients-review-renderer.tsx` and `email-drafts-review-renderer.tsx`
repeats the class 3 ceiling of the sibling leg of cinatra#3821 over those
modules. A change that grows one is red in both gates with the same cause, and
a ratchet of one is a ratchet of both. This gate reads no file of that leg, so
the two merge in either order.

## What the gates cannot see

- A host display mounted outside the dispatch consumers' host branches and
  imported by some other module too; a consumer found only through a barrel
  module that re-exports the dispatch.
- A component that a dispatch consumer mounts both in a host branch and
  outside every dispatch branch: the page-chrome rule keeps it out of
  `displays`, so its ceilings are not measured either.
- A consumer function that only returns a call of an enumerated function but
  builds that call's input itself (for example, a first-party representation
  with no semantic renderer): the delegation rule does not read the arguments.
- A display that grows inside an existing declaration without a new value
  import.
- A dispatch whose host member is chosen without an object literal of
  `kind: "mime"` (a value passed through from elsewhere). The class 8 test still
  drives every exported dispatch function, but not a caller that ignores the
  dispatch.
- A host renderer for one step registered outside the kind table (the direct
  registrations of generic builder ids in the same module).
- `src/components/artifacts/artifact-inline-preview.tsx`: a neutral preview
  that draws an image by the media type's transport class for one dashboard
  portlet. It is neither a dispatch branch nor a step renderer, so it is a
  finding recorded here and not a floor entry.

## What this change does not close

A change that adds a display and adds its entry to the committed floor in the
same pull request stays green until the base-branch guard of the floors runs
in CI, which is a later change; the floor file's diff shows such an entry to
the reviewer.
