# Declared text core gate (cinatra#4533, stages 1 and 2)

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

## What the gate reads

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
values (never the keys) of these JSON declarations (stage 1):

- `package.json`: `description` and everything under the `cinatra` field;
- `cinatra/**/*.json`;
- every `*.oas.json` in the package (the HITL steps included).

A test or fixture path is not read: a file with a directory segment
`test`, `tests`, `__tests__`, `fixtures`, `__fixtures__`, `__mocks__` or
`__stubs__` in its path inside the package, or a file whose base name is
`*.test.json`, `*.spec.json` or `*.fixture.json` (also before `.oas.json`:
`*.test.oas.json`, `*.spec.oas.json`, `*.fixture.oas.json`). `node_modules/`
and dot directories are not read either. The package's own `package.json` is
always read.

**Extension code (stage 2).** In the same packages, the code files (`.ts .tsx
.mts .cts .js .jsx .mjs .cjs`) under the package's `src/` and `cinatra/`
folders (`isExtensionCodePath`). Each file is parsed with the TypeScript
parser, and the gate reads what it reads on the core side: a string literal, a
template literal without a substitution, a JSX text. A test or fixture path is
not read: the same rule as above, extended with the code test forms that the
pinned tree has, `*.test.ts` and `*.test.tsx` (the tree has no `*.spec.*` code
file and no test file with another extension). Declaration files (`.d.ts`,
`.d.mts`, `.d.cts`) are not read. `node_modules/` and dot directories are not
read.

## The comparison

Both sides collapse every run of whitespace to one space and trim. A text
counts only with at least 20 characters, at least 4 words, a capital letter and
no template syntax (`{{`, `}}`, `${`, `{%`, `%}`, `<%`, `%>`). A core text
matches when it is equal to a counted declared text. A core text equal to a
text of the JSON declarations is a `matches` entry; a core text equal only to a
literal of the extension code is a `codeMatches` entry.

## Fail closed

Each of these is a scanner error (exit 2), never a pass:

- no pinned package;
- no extension package under `extensions/`;
- a pinned package not found under `extensions/` by its manifest name;
- two directories that name one pinned package;
- an unreadable manifest or directory, or a declaration file that does not parse;
- an extension code file that is unreadable or does not parse (the error names the file);
- a pinned tree that declares no counted text;
- a core module that does not parse;
- a missing or unreadable floor file.

## The floor

`declared-text-core-gate.baseline.json` holds the matches, key
`<file> :: <text>` with its count, in two sections: `matches` (the JSON
declarations, stage 1) and `codeMatches` (the extension code, stage 2).

- In each section, a new key or a grown count fails.
- A key whose count fell is stale and fails until `--write-baseline` lowers it.
- `--write-baseline` never raises the floor.
- With `DECLARED_TEXT_FLOOR_BASE=<ref>`, or on a pull request's run
  (`GITHUB_BASE_REF`), the shared floor base guard (`lib/floor-base-guard.mjs`)
  also refuses a committed floor that grew against the base. A base that holds
  neither the floor nor the gate is the introducing change.
- The `codeMatches` section follows the pattern of `LATER_CLASSES` in
  `agent-extension-code-gate.mjs`: a base floor without the section (its gate
  does not read extension code) seeds it once, in the change that widens the
  reading. When the section is on the base, it only shrinks like `matches`, and
  a head floor that drops it fails ("the section is removed"). `matches` is
  compared with the base in every case, so a stage 1 entry can never be added
  together with the seed.
- `--write-baseline` writes a section that the floor does not hold yet from the
  live scan (a floor without `codeMatches`), and ratchets every other section
  down.

On `main` when stage 1 was introduced, the floor is empty: no core text equals
a text in the JSON declarations of the pinned tree. The matches that
cinatra#4533 names come from the extensions' own code literals. Stage 2 seeds
`codeMatches` with 46 keys (56 occurrences) in 21 core files over the 118
pinned packages (513 extension code files). The rule is exact, so the seed
also holds generic texts that both sides spell on their own (for example
"Could not submit. Please try again.", "Unable to save the connection."), two
SVG path strings that meet the counting rule, and fragments of error texts
that the source splits over several literals.

## Next stage

- The Markdown under `skills/` of each extension.
- The step "Border floors — base guard" of `gates-pnpm` in
  `.github/workflows/gates.yml` (a workflow change).
- The admission of an advanced pin: a new match whose core file is unchanged
  at the base.

## Stated limits

- A sentence that core assembles from pieces, or holds with a substitution,
  is not read.
- A sentence that differs by one character (punctuation, a trailing word) is
  not a match.
