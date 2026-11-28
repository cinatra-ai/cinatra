# Declared text core gate (cinatra#4533, stage 1)

An extension supplies its own user-facing text, and core renders it. Core code
must not spell, word for word, a sentence that a pinned extension declares.
This gate refuses a new such sentence. The sentences core spells today stay on
a floor that only shrinks.

```
node scripts/audit/declared-text-core-gate.mjs                  # check (exit 0 clean, 1 findings, 2 scanner error)
node scripts/audit/declared-text-core-gate.mjs --write-baseline # lower the floor
DECLARED_TEXT_FLOOR_BASE=<ref> node scripts/audit/declared-text-core-gate.mjs   # also refuse a floor grown against <ref>
```

The test of record is `__tests__/declared-text-core-gate.test.mjs`. It runs in
the root suite (`pnpm test:root`, the job "Perpetual core invariants (loops,
ratchets, unit tiers)"), which clones the pinned extension tree first. On a
CI run without the tree the test fails; on a local run without the tree it is
skipped.

## What stage 1 reads

**Core side.** Application code: `src/` and every `packages/*/src`, the code
files (`.ts .tsx .mts .cts .js .jsx .mjs .cjs`). The scope, the file list and
the exemptions are those of the application border gate (its exported
`isInScope`, `isExemptFile` and `listScanFiles`): the generator-emitted files,
tests, specs, `__tests__`, `__fixtures__`, `__mocks__`, `test/`, `tests/`,
stories and `.d.ts`. Each module is parsed with the TypeScript parser. The
texts read, in any position:

- a string literal;
- a template literal without a substitution;
- a JSX text.

**Extension side.** Every package that the two locks
(`cinatra-required-extensions.lock.json`, `cinatra-dev-extensions.lock.json`)
and `cinatra.devExtensions` pin (`pinnedPackageNames` of
`lib/border-words.mjs`), found under `extensions/` by its manifest name
(`discoverExtensionDirs` of the produces gate). In each package, the string
values (never the keys) of:

- `package.json`: `description` and everything under the `cinatra` field;
- `cinatra/**/*.json`;
- every `*.oas.json` in the package (the HITL steps included).

A path that the application border gate exempts (tests and fixtures),
`node_modules/` and dot directories are not read.

## The comparison

Both sides collapse every run of whitespace to one space and trim. A text
counts only with at least 20 characters, at least 4 words, a capital letter and
no template syntax (`{{`, `}}`, `${`, `{%`, `%}`, `<%`, `%>`). A core text
matches when it is equal to a counted declared text.

## Fail closed

Each of these is a scanner error (exit 2), never a pass:

- no pinned package;
- no extension package under `extensions/`;
- a pinned package not found under `extensions/` by its manifest name;
- two directories that name one pinned package;
- an unreadable manifest or directory, or a declaration file that does not parse;
- a pinned tree that declares no counted text;
- a core module that does not parse;
- a missing or unreadable floor file.

## The floor

`declared-text-core-gate.baseline.json` holds the matches, key
`<file> :: <text>` with its count.

- A new key or a grown count fails.
- A key whose count fell is stale and fails until `--write-baseline` lowers it.
- `--write-baseline` never raises the floor.
- With `DECLARED_TEXT_FLOOR_BASE=<ref>`, or on a pull request's run
  (`GITHUB_BASE_REF`), the shared floor base guard (`lib/floor-base-guard.mjs`)
  also refuses a committed floor that grew against the base. A base that holds
  neither the floor nor the gate is the introducing change.

On `main` when stage 1 was introduced, the floor is empty: no core text equals
a text in the JSON declarations of the pinned tree. The matches that
cinatra#4533 names come from the extensions' own code literals, which the next
stage reads.

## Next stage

- The Markdown under `skills/` of each extension.
- The literals of the extensions' own code under `src/` and `cinatra/`.
- The step "Border floors — base guard" of `gates-pnpm` in
  `.github/workflows/gates.yml` (a workflow change).
- The admission of an advanced pin: a new match whose core file is unchanged
  at the base.

## Stated limits

- A sentence that core assembles from pieces, or holds with a substitution,
  is not read.
- A sentence that differs by one character (punctuation, a trailing word) is
  not a match.
