#!/usr/bin/env node
// Discovery gate for the MATERIALIZED extension test suites (cinatra#2288).
//
// WHAT WAS BROKEN. Host CI ran vitest for a HAND-LISTED set of extension
// packages — four before #2295, eight after it. Every other companion repo's
// suite ran in no gate anywhere, while each companion repo's OWN ci.yml
// deliberately skips its tests on the written grounds that the cinatra
// monorepo runs them (see `Skipping standalone tests` in every materialized
// extensions/<scope>/<slug>/.github/workflows/ci.yml). For all but the
// hand-listed few that premise was FALSE: ~1,600 tests across 30+ suites had
// no runner at all, and the host `tsc` pass — the only thing that saw those
// files — catches type defects only. A runtime regression reached production
// ungated (cinatra#2288's grounding; openai-connector#75/#76 is the concrete
// miss).
//
// WHY A LOOP AND NOT MORE PINNED STEPS. Hand-pinning is what let the hole grow
// to 32 packages: a newly cloned extension, or a new test file in an existing
// one, joined the hole by DEFAULT because nobody edited build-image.yml. This
// gate inverts that default — every materialized package is discovered, every
// vitest suite runs, and anything not run is named in the printed manifest and
// (unless it is a ledger carve-out below) turns the gate RED.
//
// WHY NOT #2249's REMEDY (fold the tier into the root vitest include). Each
// extension ships its own vitest config with package-local aliases (repoRoot
// stubs, `@/` mapping) and, where needed, a DOM environment; the root config
// would have to absorb 30+ divergent alias sets. What carries over from
// #2249 is the PRINCIPLE — discovery over per-file pinning — not its
// mechanism. Each suite keeps running under its own config, from its own
// package dir, exactly as the hand-listed steps did.
//
// THE FIVE CHECKS THIS GATE ENFORCES
//
//   1. EVERY vitest suite runs.       Discovered, never hand-listed.
//   2. NO SILENT TRUNCATION.          For every package it runs, the set of
//      test files vitest actually EXECUTED (read off the JSON reporter) must
//      cover every vitest-collectable test file ON DISK. This is not
//      theoretical: a package that ships no vitest config of its own inherits
//      the HOST ROOT vitest.config.ts, whose `include` is written for the host
//      tree — `blog-idea-artifact` and `blog-post-artifact` each ship a real
//      test file that collected NOTHING under that inherited config and exited
//      "No test files found". A file-count-blind gate would have reported
//      those two as skipped-and-fine. This one names the file and fails.
//   3. THE COMPANION SKIP STAYS HONEST (cinatra#2288 AC6). A package whose own
//      ci.yml skips its tests because the monorepo "runs these" MUST actually
//      be run here. If one is not — and is not a named carve-out — the gate
//      fails and says which repo is making a claim the host does not honour.
//      This is the invariant that keeps the premise true as the fleet grows,
//      in the only place that can prove it. A skipping package whose test
//      sources name `node:test` (the fleet's one other runner) is therefore RUN
//      here with `node --test`, one file at a time, and enforced like a vitest
//      suite: green, and every on-disk test file executed with at least one
//      test. Its own ci.yml skips it, so in CI this gate is where it runs.
//   4. CARVE-OUTS ARE PIN- AND SHAPE-SCOPED, AND SELF-RETIRING. An entry
//      tolerates ONE documented failure, at ONE pinned sha, in a CLEAN
//      checkout of it. It is still RUN. If the observed shape differs from the
//      recorded one in ANY direction — more failures, DIFFERENT failures at the
//      same count, fewer tests collected, different uncollected files, a
//      different exit code, or newly green —
//      the gate FAILS and prints both shapes, because the entry no longer
//      describes reality. If the pin MOVES — or the package's own repository
//      identity cannot be established, or its tree has local modifications —
//      the entry stops applying altogether and the package is enforced like
//      any other: green passes, red blocks. A carve-out can therefore neither
//      absorb a regression it was not written for nor quietly outlive the
//      defect it documents — the exact failure mode that produced
//      cinatra#2288.
//
//      A stale entry (pin moved past it, or the package is gone) is a NOTICE,
//      not a failure: it already grants no exemption, and hard-failing on it
//      would block the automated dev-lock bump PR on a bookkeeping edit.
//   5. "NOT VITEST" IS A FINDING, NOT AN ASSUMPTION. A package with test files
//      that this gate declines to run must say WHY on evidence: a test source
//      naming `node:test` (the fleet's one other runner) proves another runner
//      exists. With no vitest signal AND no such name, the "other" verdict is a
//      guess, and the manifest line `its own CI runs <script>` would be a claim
//      nothing checked — a written-but-unverified premise, which is the defect
//      cinatra#2288 documents, not a fix for it. The gate FAILS instead.
//      Closes the one discovery escape a signal-based classifier still had: a
//      suite written against vitest's GLOBALS, in a package that names vitest
//      nowhere, imports it nowhere, and ships no config, would otherwise be
//      classified "other" and silently rejoin the hole.
//
// FAIL-CLOSED. Zero materialized packages, or zero discovered vitest suites,
// is a hard failure (the clone-back-failed / classifier-broke case), mirroring
// extension-conformance-gate.yml's own zero-packages guard. A vacuous pass
// here would recreate the hole silently.
//
// USAGE
//   node scripts/ci/extension-suite-gate.mjs            # discover + run + judge
//   node scripts/ci/extension-suite-gate.mjs --list     # manifest only, runs nothing
//   EXTENSION_SUITE_JOBS=4                              # parallel suites (default 4)
//
// `--list` is a HUMAN-ONLY inspection mode: it runs no suite and exits 0, which
// is correct for a manifest and would be a bypass in CI. The workflow invokes
// this script with NO arguments (build-image.yml, `Extension suites — discovery
// gate`), so the CI path can only be the judging one. Kept as a flag rather
// than a second entrypoint because that is the shape the rest of scripts/ci
// uses; the thing that makes it safe is the call site, which is in the diff.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// CARVE-OUT LEDGER
//
// Every entry is BY NAME and BY SHA, records the EXACT failure it tolerates,
// carries a written reason, names the upstream repair, and states what retires
// it. A blanket `|| true`, a silent skip, or an unexplained name is not
// acceptable here — that is the defect cinatra#2288 documents, not a fix for
// it. Neither is an open-ended name: an entry that tolerated "whatever this
// package does" would absorb the next real regression, which is the same hole
// one level in.
//
//   id      — SCOPE-QUALIFIED package identity, `<scope>/<dir>`. Not the bare
//             directory name: two scopes can hold the same slug, and a
//             slug-keyed ledger would hand one written exemption to both.
//   sha     — the ONE materialized commit this applies at. The clone-back
//             checks each companion out DETACHED at its committed lock pin, so
//             this is exactly that pin. Any other sha and the entry is inert.
//   expect  — the exact observed shape:
//             { exitCode, totalTests, failedTests, pendingTests,
//               failedTestNames, uncollected }.
//             `uncollected` lists on-disk test files vitest did not execute
//             (this is also how a DELIBERATE package-local exclusion would be
//             represented, should one ever be legitimate — named, not implied).
//             Every field is compared EXACTLY, and an omitted numeric field
//             reads as 0 — so an entry cannot tolerate more than it wrote down.
//
// ALL SIX entries below are the same transient shape: the suite is repaired at
// the companion repo's main, and the committed dev-lock pin still predates the
// repair. Wiring knowingly-red pins instead would make this gate red on arrival
// and teach everyone to ignore it — and the brief for this slice says so
// explicitly. The dev-lock auto-bump (.github/workflows/dev-lock-auto-bump.yml,
// weekdays 06:37 UTC) moves the pins past these repairs; at that point each
// entry stops applying, its package becomes enforced, and the entry is deleted
// as bookkeeping (a NOTICE, never a blocked bump).
// ---------------------------------------------------------------------------
export const CARVE_OUTS = [
  {
    id: "cinatra-ai/a2a-server-connector",
    sha: "d1e342c7bf1167c1a3e2eab371d48b2c445008a9",
    expect: {
      exitCode: 1, totalTests: 63, failedTests: 6, pendingTests: 0,
      failedTestNames: [
        "src/__tests__/a2a-setup-toast.dom.test.tsx › A2A setup — SearchParamToast DOM render ?error=invalid-url fires an error toast with the static message",
        "src/__tests__/a2a-setup-toast.dom.test.tsx › A2A setup — SearchParamToast DOM render ?notice=added fires a success toast with the static 'added' message",
        "src/__tests__/a2a-setup-toast.dom.test.tsx › A2A setup — SearchParamToast DOM render ?notice=removed fires a warning toast with the static 'removed' message",
        "src/__tests__/a2a-setup-toast.dom.test.tsx › A2A setup — SearchParamToast DOM render a crafted/unknown error code is ignored — never toasted (codes-only protocol)",
        "src/__tests__/a2a-setup-toast.dom.test.tsx › A2A setup — SearchParamToast DOM render fires no toast when the URL carries no flash code",
        "src/__tests__/a2a-setup-toast.dom.test.tsx › A2A setup — SearchParamToast DOM render renders nothing visible (island is a null-rendering effect component)",
      ],
      uncollected: [],
    },
    reason:
      "6 of 63 tests red at the pinned sha: vitest.config.ts aliased its vendored next/navigation + sonner stubs ONLY when the real specifier failed to resolve, so inside the monorepo the real modules won and useRouter() threw outside a mounted App Router.",
    upstream: "cinatra-ai/a2a-server-connector#52 (merged 2026-07-31) — stubs aliased unconditionally; 63/63 green",
    retiresWhen: "the dev-lock pin moves to e64d99e0f47e or later",
  },
  {
    id: "cinatra-ai/email-artifacts",
    sha: "86c3ad126832613a45e8bc36bcabd90fdc6e5a93",
    expect: {
      exitCode: 1, totalTests: 57, failedTests: 29, pendingTests: 0,
      failedTestNames: [
        "src/__tests__/email-drafts-review.test.tsx › EmailDraftsReviewRenderer does not re-emit onChange when the parent re-renders with a content-equal but new value object (loop guard, cinatra#1959)",
        "src/__tests__/email-drafts-review.test.tsx › EmailDraftsReviewRenderer emits edited=true with the new subject when the operator types",
        "src/__tests__/email-drafts-review.test.tsx › EmailDraftsReviewRenderer renders one card per draft with the recipient and seeds the resume payload",
        "src/__tests__/email-drafts-review.test.tsx › EmailDraftsReviewRenderer renders the follow-up day badge for a followupBundle",
        "src/__tests__/email-drafts-review.test.tsx › EmailDraftsReviewRenderer shows the empty state and emits nothing when the snapshot has no drafts",
        "src/__tests__/follow-up-cadence.test.tsx › FollowUpCadenceFieldRenderer (relocated to @cinatra-ai/email-artifacts) clamps entered days into the 1..30 range",
        "src/__tests__/follow-up-cadence.test.tsx › FollowUpCadenceFieldRenderer (relocated to @cinatra-ai/email-artifacts) defaults to [4, 11, 25] when value is not an array",
        "src/__tests__/follow-up-cadence.test.tsx › FollowUpCadenceFieldRenderer (relocated to @cinatra-ai/email-artifacts) pushes keystroke changes immediately when hideSubmit is true and hides Continue",
        "src/__tests__/follow-up-cadence.test.tsx › FollowUpCadenceFieldRenderer (relocated to @cinatra-ai/email-artifacts) registers a flush callback that pushes the latest days",
        "src/__tests__/follow-up-cadence.test.tsx › FollowUpCadenceFieldRenderer (relocated to @cinatra-ai/email-artifacts) submits via Continue when hideSubmit is false",
        "src/__tests__/gmail-sender.test.tsx › GmailSenderFieldRenderer (component-only relocation to @cinatra-ai/email-artifacts) renders a placeholder when no value is selected",
        "src/__tests__/gmail-sender.test.tsx › GmailSenderFieldRenderer (component-only relocation to @cinatra-ai/email-artifacts) renders the label with a required marker",
        "src/__tests__/gmail-sender.test.tsx › GmailSenderFieldRenderer (component-only relocation to @cinatra-ai/email-artifacts) surfaces a caller-supplied error",
        "src/__tests__/gmail-sender.test.tsx › GmailSenderFieldRenderer (component-only relocation to @cinatra-ai/email-artifacts) tolerates an absent gmailAliases context without throwing",
        "src/__tests__/send-confirmation.test.tsx › SendConfirmationRenderer — approval payload does not emit while no campaign is selected",
        "src/__tests__/send-confirmation.test.tsx › SendConfirmationRenderer — approval payload emits { campaignId } only — never senderEmail, even when the gate surfaced one (send uses the campaign-configured sender)",
        "src/__tests__/send-confirmation.test.tsx › SendConfirmationRenderer — controlled re-render summary preservation (cinatra#1961) echoes the gate summary into the emitted approval payload (round-trip fidelity)",
        "src/__tests__/send-confirmation.test.tsx › SendConfirmationRenderer — controlled re-render summary preservation (cinatra#1961) keeps the recipient/draft counts when the parent echoes the emitted payload back as value",
        "src/__tests__/send-confirmation.test.tsx › SendConfirmationRenderer — scheduledAt row (surfaced snapshot field) omits the Scheduled row for an immediate send (no scheduledAt)",
        "src/__tests__/send-confirmation.test.tsx › SendConfirmationRenderer — scheduledAt row (surfaced snapshot field) renders a Scheduled row when the summary carries a scheduledAt",
        "src/__tests__/send-confirmation.test.tsx › SendConfirmationRenderer — sender is display-only (owner ruling 2026-07-23) renders NO editable sender even when gmail is CONNECTED with aliases",
        "src/__tests__/send-confirmation.test.tsx › SendConfirmationRenderer — sender is display-only (owner ruling 2026-07-23) renders the sender address as plain read-only data — no input, no picker",
        "src/__tests__/send-confirmation.test.tsx › SendConfirmationRenderer — senderEmail read-only display (latched) keeps the sender displayed after the self-erasing emit round-trip (display-only latch)",
        "src/__tests__/send-confirmation.test.tsx › SendConfirmationRenderer — senderEmail read-only display (latched) reflects value.senderEmail as read-only text and updates on external change (a@x.com -> b@x.com)",
        "src/__tests__/send-confirmation.test.tsx › SendConfirmationRenderer — senderEmail read-only display (latched) reseeds on a campaign switch — the prior campaign's sender never leaks",
        "src/__tests__/send-confirmation.test.tsx › SendConfirmationRenderer — snapshot summary (action-decoupled, cinatra#1961) always shows the irreversible-send warning",
        "src/__tests__/send-confirmation.test.tsx › SendConfirmationRenderer — snapshot summary (action-decoupled, cinatra#1961) renders the pre-setup message when no campaign is selected yet",
        "src/__tests__/send-confirmation.test.tsx › SendConfirmationRenderer — snapshot summary (action-decoupled, cinatra#1961) renders the recipient/draft counts PURELY from the gate-supplied value.summary",
        "src/__tests__/send-confirmation.test.tsx › SendConfirmationRenderer — snapshot summary (action-decoupled, cinatra#1961) shows the em-dash never-blank floor when the snapshot omits the summary",
      ],
      uncollected: [],
    },
    reason:
      "29 of 57 tests red at the pinned sha (ReferenceError: document is not defined): the package ships no vitest config, so a pack of React client renderers asserted through @testing-library/react ran under the inherited host-root NODE environment.",
    upstream:
      "cinatra-ai/email-artifacts#12 (merged 2026-07-31) — package-local vitest.config.ts with environment: jsdom; 57/57 green",
    retiresWhen: "the dev-lock pin moves to 660d02017edc or later",
  },
  {
    id: "cinatra-ai/linkedin-connector",
    sha: "a342d0fcbb3caef1f81d105fcbdc346a73e28a14",
    expect: {
      exitCode: 1, totalTests: 49, failedTests: 7, pendingTests: 0,
      failedTestNames: [
        "src/__tests__/linkedin-connect-section.dom.test.tsx › LinkedInConnectSection — canonical error-code emission disables the button and passes the prerequisite message when credentials aren't configured",
        "src/__tests__/linkedin-connect-section.dom.test.tsx › LinkedInConnectSection — canonical error-code emission emits ?error=authorization-failed (never the raw provider message) when the connect attempt errors",
        "src/__tests__/linkedin-connect-section.dom.test.tsx › LinkedInConnectSection — canonical error-code emission preserves any other existing query params when writing the error code",
        "src/__tests__/linkedin-setup-toast.dom.test.tsx › LinkedIn setup — SearchParamToast DOM render ?error=authorization-failed fires an error toast with the static message",
        "src/__tests__/linkedin-setup-toast.dom.test.tsx › LinkedIn setup — SearchParamToast DOM render a crafted/unknown error code is ignored — never toasted (codes-only protocol)",
        "src/__tests__/linkedin-setup-toast.dom.test.tsx › LinkedIn setup — SearchParamToast DOM render fires no toast when the URL carries no flash code",
        "src/__tests__/linkedin-setup-toast.dom.test.tsx › LinkedIn setup — SearchParamToast DOM render renders nothing visible (island is a null-rendering effect component)",
      ],
      uncollected: [],
    },
    reason:
      "7 of 49 tests red at the pinned sha — the same conditional-stub seam defect as a2a-server-connector, plus @cinatra-ai/sdk-ui/marketplace and a missing server-only stub.",
    upstream: "cinatra-ai/linkedin-connector#69 (merged 2026-07-31) — unconditional seams + server-only stub; 59/59 green",
    retiresWhen: "the dev-lock pin moves to e8c48ff840dc or later",
  },
  {
    id: "cinatra-ai/blog-idea-artifact",
    sha: "79a3f6c137e0035fc2d20b511cfe25aea1caee27",
    expect: { exitCode: 1, totalTests: 0, failedTests: 0, pendingTests: 0, failedTestNames: [], uncollected: ["tests/object-renderers.test.tsx"] },
    reason:
      'ships tests/object-renderers.test.tsx and declares "test": "vitest run", but has no vitest config at the pinned sha — so vitest inherits the HOST ROOT config, whose include matches nothing in the package, and exits 1 with "No test files found". Its declared test script is a no-op in the monorepo layout.',
    upstream: "cinatra-ai/blog-idea-artifact#40 (merged 2026-07-31) — package-local vitest.config.ts; 4 tests collect and pass",
    retiresWhen: "the dev-lock pin moves to 68a9dd8cb82f or later",
  },
  {
    id: "cinatra-ai/blog-post-artifact",
    sha: "3d2094e69a7d2b65815ba67835a1ab5cf0f7580b",
    expect: { exitCode: 1, totalTests: 0, failedTests: 0, pendingTests: 0, failedTestNames: [], uncollected: ["tests/object-renderers.test.tsx"] },
    reason:
      'identical to blog-idea-artifact: a real test file, a declared "vitest run" script, no package-local config at the pinned sha, and therefore "No test files found" under the inherited host-root include.',
    upstream: "cinatra-ai/blog-post-artifact#41 (merged 2026-07-31) — package-local vitest.config.ts; 5 tests collect and pass",
    retiresWhen: "the dev-lock pin moves to e779e2baaf0f or later",
  },
  {
    // Found BY THIS GATE, on its first run — not by the cinatra#2288 survey,
    // which counted packages and never compared per-package file sets. Note the
    // recorded shape: exitCode 0. The suite is GREEN. Every count-based look at
    // this package says healthy, which is exactly why it survived.
    id: "cinatra-ai/wordpress-assistant-connector",
    sha: "e00830bb26300a0ff71d8b4c9da4720bfedca184",
    expect: { exitCode: 0, totalTests: 10, failedTests: 0, pendingTests: 0, failedTestNames: [], uncollected: ["tests/contracts/wp-drupal/contract-v1.test.ts"] },
    reason:
      "GREEN but INCOMPLETE at the pinned sha: 1 of its 3 test files — the canonical wp-drupal-assistant v1 wire-contract conformance suite (schemas + golden fixtures) — is outside the inherited host-root include and has been collected by NOTHING since it landed in that repo's #4. Its own CI skips tests (host-internal peers), so those 13 assertions have never executed anywhere. Verified: under a package-local config the package runs 3 files / 23 tests, all green, vs 2 files / 10 tests today.",
    upstream: "cinatra-ai/wordpress-assistant-connector#47 — package-local vitest.config.ts so all three files collect",
    retiresWhen: "the dev-lock pin moves past that repair",
  },
];

// ---------------------------------------------------------------------------
// Pure core (unit-tested in scripts/ci/__tests__/extension-suite-gate.test.mjs)
// ---------------------------------------------------------------------------

// Vitest's DEFAULT include is `**/*.{test,spec}.?(c|m)[jt]s?(x)`. On-disk
// discovery deliberately uses that default rather than each package's own
// `include`: the point of check 2 is to catch a file the package's config does
// NOT collect. Reading the config's own include would make the check circular.
export const TEST_FILE_RE = /\.(test|spec)\.(?:c|m)?[jt]sx?$/;

export const WALK_SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  ".turbo",
  ".vercel",
  "coverage",
  "dist",
  "build",
  "out",
]);

const VITEST_CONFIG_RE = /^vite(?:st)?\.(?:config|workspace)\.(?:c|m)?[jt]s$/;
const VITEST_IMPORT_RE = /(?:from\s*|require\(\s*)["']vitest["']/;
// The one OTHER runner this fleet actually uses. Unlike vitest, `node:test`
// has no globals — a file using it must name the module — so an import is a
// RELIABLE positive, which is what lets "no vitest AND no node:test" be treated
// as an unidentified runner rather than assumed to be somebody's business.
export const NODE_TEST_IMPORT_RE = /(?:from\s*|require\(\s*)["']node:test["']/;

// Mirrors the companion ci.yml's own `first_party` classifier verbatim: a
// SOURCE MIRROR is a repo declaring >=1 host-internal peer under either scope.
// Those repos skip their standalone install/typecheck/test.
export function isFirstPartyMirror(pkgJson) {
  return Object.keys(pkgJson?.peerDependencies ?? {}).some(
    (k) => k.startsWith("@cinatra-ai/") || k.startsWith("@cinatra/"),
  );
}

// Does this package's own CI skip its tests on the "the host runs these"
// grounds? Both halves must hold: the workflow carries the skip branch AND the
// package qualifies as a first-party mirror, which is what arms it.
export function skipsStandaloneTests({ pkgJson, ciWorkflow }) {
  return isFirstPartyMirror(pkgJson) && /Skipping standalone tests/.test(ciWorkflow ?? "");
}

/**
 * Decide how a materialized package is (or is not) gated here.
 *
 * runner:
 *   "none"   — no test file AND no declared vitest suite; nothing to gate.
 *   "vitest" — a vitest suite: this gate runs it.
 *   "other"  — ships test files that are NOT vitest (today: four agent repos
 *              on `node --test`). Recorded in the manifest, never silently
 *              dropped. If such a package ALSO skips its tests standalone,
 *              nothing else runs them: with "node-test" evidence this gate
 *              runs them itself (planRun's `nodeRun`); with "unknown"
 *              evidence check 3 fails, because it cannot.
 *
 * runnerEvidence — WHAT the "other" verdict actually rests on, kept separate
 * from the verdict itself so an ASSUMPTION cannot pass for a finding:
 *   "vitest"    — this gate runs it.
 *   "node-test" — a test file names `node:test`, so another runner demonstrably
 *                 exists and the package's own CI is the thing that runs it.
 *   "unknown"   — test files on disk, no vitest signal, and no recognized
 *                 runner named anywhere in them. "other" is then a GUESS, and
 *                 the manifest's `its own CI runs <script>` line would be a
 *                 claim this gate never checked — the exact shape of the defect
 *                 cinatra#2288 documents. `judge` refuses it (check 5).
 *   "none"      — no test files.
 */
export function classifyPackage({ slug, id, sha, dirty, dir, pkgJson, entries = [], testFiles = [], readTestSource, ciWorkflow }) {
  const scripts = pkgJson?.scripts ?? {};
  const deps = { ...(pkgJson?.dependencies ?? {}), ...(pkgJson?.devDependencies ?? {}) };
  const testScript = typeof scripts.test === "string" ? scripts.test : "";
  const hasOwnConfig = entries.some((e) => VITEST_CONFIG_RE.test(e));

  // DECLARED INTENT — a package's own claim that it HAS a vitest suite, made
  // independently of what the default-name walk finds. This is what closes the
  // discovery escape a name-only classifier leaves open: a package whose config
  // `include` is written for custom names (`*.unit.ts`, a `tests/` glob with
  // another suffix) ships zero files matching vitest's DEFAULT include, so a
  // name-only scan would classify it "none" and never run it — the same silent
  // non-coverage cinatra#2288 is about, reintroduced one level in. When intent
  // is declared the suite is RUN regardless, and vitest itself decides what its
  // config collects; if that is nothing, vitest exits 1 and this gate fails
  // loudly with the package named. Zero packages on the tree are in that state
  // today (verified across all 111), so this is a guard against the next one,
  // not a live behaviour change.
  //
  // A bare `vitest` DEPENDENCY is deliberately NOT intent: the fleet carries it
  // transitively in packages that ship no suite at all, and running those would
  // fail the gate for having no tests to run.
  const declaresVitestIntent = hasOwnConfig || /\bvitest\b/.test(testScript);

  // With files present, three further signals classify vitest vs node:test,
  // because no single one covers the fleet: a package can ship a config and no
  // test script (pdf-artifact), a "vitest" test script and no config
  // (anthropic-connector), or NEITHER while still shipping six vitest suites
  // (email-artifacts). The last signal — the test sources themselves importing
  // vitest — is the ground truth the other two approximate.
  const declaresVitest =
    declaresVitestIntent ||
    Object.prototype.hasOwnProperty.call(deps, "vitest") ||
    testFiles.some((f) => VITEST_IMPORT_RE.test(readTestSource?.(f) ?? ""));

  const runner =
    testFiles.length === 0 ? (declaresVitestIntent ? "vitest" : "none") : declaresVitest ? "vitest" : "other";

  // Only asked once the vitest signals have all missed, and answered from the
  // test SOURCES rather than from package.json: a `test` script is a claim, and
  // a claim is what must not be trusted here. Four packages on the tree are in
  // the "node-test" state today and none is "unknown", so this is the same
  // guard-against-the-next-one posture as declaresVitestIntent above.
  const runnerEvidence =
    runner === "vitest"
      ? "vitest"
      : runner === "none"
        ? "none"
        : testFiles.some((f) => NODE_TEST_IMPORT_RE.test(readTestSource?.(f) ?? ""))
          ? "node-test"
          : "unknown";

  return {
    slug,
    // Scope-qualified identity. Results, report filenames and ledger matching
    // all key on this, so two same-named dirs under different scopes cannot
    // overwrite each other's result (they would silently halve the run).
    id: id ?? `cinatra-ai/${slug}`,
    // The materialized commit, or null when this package's own repository
    // identity could not be established (see resolveMaterializedSha). A null
    // sha matches no ledger entry, so the package is ENFORCED — the safe
    // direction.
    sha: sha ?? null,
    // Whether the materialized checkout has local modifications. CI's
    // clone-back never produces one; a workstation run (or a planted red-proof
    // edit) does. A dirty tree means the CONTENT is no longer the content the
    // pin names, so a carve-out written against that pin must not apply to it.
    dirty: dirty === true,
    dir,
    runner,
    runnerEvidence,
    testScript,
    hasOwnConfig,
    testFiles: [...testFiles].sort(),
    firstPartyMirror: isFirstPartyMirror(pkgJson),
    standaloneTestsSkipped: skipsStandaloneTests({ pkgJson, ciWorkflow }),
  };
}

/**
 * Establish a materialized package's OWN repository identity, or refuse to.
 *
 * `git -C <dir> rev-parse HEAD` is not enough on its own: git walks UPWARD, so
 * a package directory whose nested `.git` is missing or broken answers with the
 * HOST repository's HEAD — a real sha, for the wrong repository. That value
 * would be silently wrong in the manifest and, worse, is the value a carve-out
 * is bound to. Requiring `--show-toplevel` to BE the package directory is what
 * makes the sha provably this package's.
 *
 * Pure so both refusal paths are unit-tested rather than assumed. Returns
 * { sha, dirty }; `sha: null` means "identity unavailable", which matches no
 * ledger entry and therefore enforces the package.
 */
export function resolveMaterializedSha({ pkgDir, toplevel, head, status }) {
  if (!toplevel || !head) return { sha: null, dirty: false };
  if (path.resolve(toplevel) !== path.resolve(pkgDir)) return { sha: null, dirty: false };
  return { sha: head, dirty: String(status ?? "").trim().length > 0 };
}

/**
 * Split the classified fleet into the enforced set, the carved set and the
 * inert ledger entries.
 *
 * A carve-out applies ONLY at the sha it was written against, and ONLY to a
 * CLEAN checkout of it. The moment the pin moves, the entry stops granting
 * anything and its package is enforced like every other suite — so a bumped pin
 * that is green simply passes, and one that is red blocks. That is what makes
 * the ledger self-retiring without a bookkeeping edit being able to block the
 * automated pin bump.
 *
 * The CLEAN requirement matters because a sha names a commit, not a working
 * tree: local edits leave `rev-parse HEAD` untouched, so without it an entry
 * written for one revision's known defect would also excuse whatever a modified
 * tree does. Both refusals fail in the SAFE direction — the package is enforced.
 */
export function planRun({ packages, carveOuts = CARVE_OUTS }) {
  const byId = new Map(carveOuts.map((c) => [c.id, c]));
  const run = [];
  const carved = [];
  const stale = [];
  // node:test suites whose own CI skips them (check 3). They are always
  // ENFORCED: the ledger is written in vitest's report vocabulary and has no
  // entry for them, so a carve-out can never apply to one.
  const nodeRun = packages.filter(isHostRunNodeTest);
  for (const p of packages) {
    if (p.runner !== "vitest") continue;
    const entry = byId.get(p.id);
    if (entry && p.sha != null && entry.sha === p.sha && !p.dirty) carved.push({ ...p, carveOut: entry });
    else run.push(p);
  }
  for (const c of carveOuts) {
    const p = packages.find((x) => x.id === c.id);
    if (!p) stale.push({ carveOut: c, why: `not materialized under extensions/` });
    else if (p.runner !== "vitest") stale.push({ carveOut: c, why: `no longer a vitest suite (runner=${p.runner})` });
    else if (p.sha == null)
      stale.push({
        carveOut: c,
        why: `the materialized checkout's own repository identity could not be established (no nested git repo at its directory) — the entry cannot be bound to a revision, so the suite is ENFORCED`,
      });
    else if (p.sha !== c.sha) stale.push({ carveOut: c, why: `pin moved to ${String(p.sha).slice(0, 12)} — entry was written for ${String(c.sha).slice(0, 12)}; the suite is now ENFORCED` });
    else if (p.dirty)
      stale.push({
        carveOut: c,
        why: `the checkout at ${String(p.sha).slice(0, 12)} has LOCAL MODIFICATIONS — the entry documents a defect in that commit's content, not in an edited tree, so the suite is ENFORCED`,
      });
  }
  return { run, carved, stale, nodeRun };
}

/**
 * Is this a node:test package that, in CI, only this gate runs? Its tests are not
 * vitest, its test sources name `node:test`, and its own ci.yml skips them on
 * the "the cinatra monorepo runs these" grounds. Without this road the gate
 * could only name such a package (check 3) and never satisfy the claim.
 */
export function isHostRunNodeTest(p) {
  return p.runner === "other" && p.runnerEvidence === "node-test" && p.standaloneTestsSkipped === true && p.testFiles.length > 0;
}

/**
 * Read the TAP that `node --test --test-reporter=tap <file>` prints into the
 * fields the rules use. Pure, so a missing summary is tested, not assumed.
 *
 * The summary is the TOP-LEVEL `# tests N` / `# pass N` / `# fail N` /
 * `# cancelled N` / `# skipped N` / `# todo N` block node prints last; an
 * indented line belongs to a subtest and is never read as the summary. No
 * `# tests` line at top level returns `summary: false`, which the caller treats
 * as a lost report (fail-closed), never as zero failures.
 *
 * A file that registers no test is not reported as zero tests: node reports
 * the FILE ITSELF as one test, named by the path it was given (`ok 1 -
 * test/x.test.mjs`, `# tests 1`, `# suites 0`), at line 1, column 1 of the
 * file. The TAP name is not read for this: node escapes and a ` # SKIP` or
 * ` # TODO` directive can change how a path reads in TAP. A run whose TAP has
 * exactly one top-level result and no suite is therefore `fileOnly` unless a
 * top-level record (`topLevel`, from nodeTopLevelReporter) gives a location
 * that proves a real test: a line and a column that are both positive
 * integers and are not line 1, column 1. A missing record, a null or unknown
 * location, and 1:1 all read as file-only; the caller then does not count the
 * file as executed. The cost is a false red, never a false green: a real lone
 * test whose call starts at line 1, column 1, or whose record was lost, also
 * reads as file-only.
 */
// A top-level record proves a real test only by a location node gives a test
// call: a positive-integer line and column, other than node's 1:1 for the file.
export function provesRealTest(r) {
  return Boolean(r) && Number.isInteger(r.line) && Number.isInteger(r.column) && r.line > 0 && r.column > 0 && !(r.line === 1 && r.column === 1);
}

export function parseNodeTap(text, file, topLevel = []) {
  const counts = {};
  const failedNames = [];
  let topResults = 0;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const c = /^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(line);
    if (c) counts[c[1]] = Number(c[2]);
    const f = /^\s*not ok \d+ - (.*?)(?:\s+#\s+(?:SKIP|TODO)\b.*)?$/.exec(line);
    if (f && !/#\s+(?:SKIP|TODO)\b/.test(line)) failedNames.push(f[1]);
    if (/^(?:not )?ok \d+ /.test(line)) topResults += 1;
  }
  const fileOnly = topResults === 1 && (counts.suites ?? 0) === 0 && !topLevel.some(provesRealTest);
  return {
    summary: Object.prototype.hasOwnProperty.call(counts, "tests"),
    tests: counts.tests ?? 0,
    pass: counts.pass ?? 0,
    fail: counts.fail ?? 0,
    cancelled: counts.cancelled ?? 0,
    skipped: counts.skipped ?? 0,
    todo: counts.todo ?? 0,
    failedNames,
    fileOnly,
  };
}

/**
 * Fold the per-file node:test runs of one package into the result shape the
 * vitest road produces, so the same rules judge both. A file counts as
 * EXECUTED only when its run printed a summary with at least one test of its
 * own: a file node ran that registered nothing (reported as zero tests, or as
 * the file itself, see parseNodeTap) is uncollected, as a vitest file collected
 * by nothing is, and node's report of the file is not counted as a test. A
 * file whose run printed no summary makes the report lost, and so does a file
 * killed at the file bound or at the gate's node:test deadline
 * (runNodeTestFile), whatever TAP it printed first, and a file not started
 * because that deadline had passed (runNodeTest).
 *
 * files: Array<{ file, exitCode, tap, timedOut?, notStarted?, topLevel? }>
 */
export function foldNodeRuns(files) {
  const executedFiles = [];
  const failedTestNames = [];
  const timedOutFiles = [];
  const notStartedFiles = [];
  let total = 0;
  let failed = 0;
  let pending = 0;
  let reportOk = files.length > 0;
  let exitCode = 0;
  let ok = files.length > 0;
  for (const { file, exitCode: code, tap, timedOut, notStarted, topLevel } of files) {
    const t = parseNodeTap(tap, file, topLevel);
    if (timedOut) timedOutFiles.push(file);
    if (notStarted) notStartedFiles.push(file);
    if (!t.summary || timedOut || notStarted) reportOk = false;
    if (t.summary && t.tests > 0 && !t.fileOnly && !timedOut && !notStarted) executedFiles.push(file);
    if (!t.fileOnly) total += t.tests;
    failed += t.fail + t.cancelled;
    pending += t.skipped + t.todo;
    for (const n of t.failedNames) failedTestNames.push(`${file} › ${n}`);
    if (code !== 0 && exitCode === 0) exitCode = code ?? -1;
    if (code !== 0 || !t.summary || t.fail > 0 || t.cancelled > 0) ok = false;
  }
  return {
    ok,
    exitCode,
    reportOk,
    executedFiles: executedFiles.sort(),
    numTotalTests: total,
    numFailedTests: failed,
    numPendingTests: pending,
    failedTestNames: failedTestNames.sort(),
    timedOutFiles: timedOutFiles.sort(),
    notStartedFiles: notStartedFiles.sort(),
  };
}

/**
 * The observed shape of one suite run, in the same vocabulary the ledger uses.
 * Pure so the comparison is testable without spawning anything.
 *
 * WHY `totalTests` AND `pendingTests` AND NOT JUST THE FAILURE COUNT. The
 * package's CONTENT cannot drift under an entry — a sha names an immutable
 * commit, and `planRun` additionally refuses to apply an entry to a checkout
 * with local modifications — so "someone swapped one failure for another at the
 * same pin" is not what these guard. What CAN move underneath a pinned entry is
 * the HOST side: this repo's own dependency tree, the node major, this gate's
 * own vitest flags. Under that kind of drift a file can still be EXECUTED (so
 * `uncollected` stays empty) while collecting fewer tests than it did — a
 * `describe` that stops registering, a suite quietly `.skip`ped. `totalTests`
 * and `pendingTests` make that visible instead of letting the failure count
 * alone certify a shrunken run as the documented defect.
 *
 * `failedTestNames` closes the same channel from the other side, and it is not
 * redundant with the count: under host drift the documented failures can
 * RECOVER while the same number of DIFFERENT tests break, at which point every
 * count still matches and an entry written for one defect silently certifies
 * another (Codex round-1 finding on this change; adopted). The recorded name is
 * `<file> › <full test name>` — derived from the test's own identity, not from
 * its error message — so it is stable across runner OS and vitest patch
 * versions, and moves only when the set of failing tests actually moves, which
 * is precisely the event this must not tolerate.
 */
export function observedShape(pkg, res) {
  const executed = new Set(res?.executedFiles ?? []);
  return {
    exitCode: res?.exitCode ?? null,
    totalTests: res?.numTotalTests ?? 0,
    failedTests: res?.numFailedTests ?? 0,
    pendingTests: res?.numPendingTests ?? 0,
    failedTestNames: [...(res?.failedTestNames ?? [])].sort(),
    uncollected: pkg.testFiles.filter((f) => !executed.has(f)),
  };
}

const sameList = (x = [], y = []) => {
  const a = [...x].sort();
  const b = [...y].sort();
  return a.length === b.length && a.every((v, i) => v === b[i]);
};

/** Exact, order-insensitive shape equality against a ledger entry's `expect`. */
export function shapeMatches(expected, actual) {
  if (!expected) return false;
  return (
    (expected.exitCode ?? 0) === actual.exitCode &&
    (expected.totalTests ?? 0) === actual.totalTests &&
    (expected.failedTests ?? 0) === actual.failedTests &&
    (expected.pendingTests ?? 0) === actual.pendingTests &&
    sameList(expected.failedTestNames, actual.failedTestNames) &&
    sameList(expected.uncollected, actual.uncollected)
  );
}

// Prints the FULL failing-test and uncollected-file lists rather than counts
// alone, so a drift error hands a human the exact text a re-derived ledger
// entry needs instead of sending them off to reproduce the run.
const fmtShape = (s) =>
  `exit ${s.exitCode}, ${s.totalTests ?? 0} test(s), ${s.failedTests ?? 0} failing, ` +
  `${s.pendingTests ?? 0} pending, ${(s.uncollected ?? []).length} uncollected file(s)` +
  ((s.uncollected ?? []).length ? ` [${s.uncollected.join(", ")}]` : "") +
  ((s.failedTestNames ?? []).length ? `; failing: [${s.failedTestNames.join(" | ")}]` : "");

/**
 * Turn a vitest JSON report into the fields the rules need. Extracted and pure
 * so the missing/corrupt-report path is unit-tested rather than assumed: a null
 * report yields ZERO executed files, which makes every on-disk file read as
 * uncollected and fails the package — deliberately fail-closed.
 *
 * `failedTestNames` is `<file> › <full test name>` for every failing assertion,
 * which is what lets a ledger entry name the failures it tolerates instead of
 * only counting them.
 */
export function parseReport({ report, pkgDir, relativize = (from, to) => to.slice(from.length + 1) }) {
  const rows = report?.testResults ?? [];
  const rel = (n) => relativize(pkgDir, n).split("\\").join("/");
  const failedTestNames = [];
  for (const r of rows) {
    for (const a of r?.assertionResults ?? []) {
      if (a?.status === "failed") failedTestNames.push(`${rel(r.name)} › ${a.fullName ?? a.title ?? "?"}`);
    }
  }
  return {
    executedFiles: rows.map((r) => rel(r.name)),
    numTotalTests: report?.numTotalTests,
    numFailedTests: report?.numFailedTests,
    numPendingTests: report?.numPendingTests,
    failedTestNames: failedTestNames.sort(),
  };
}

/**
 * Turn the classified fleet + the raw run results into blocking findings and
 * non-blocking notices. Pure: every input is data, so the rule set is
 * unit-testable without spawning a single vitest process.
 *
 * results: Map<id, { ok, exitCode, executedFiles: string[], numTotalTests,
 *                    numFailedTests, durationMs, detail }>
 */
export function judge({ packages, results, carveOuts = CARVE_OUTS }) {
  const findings = [];
  const notices = [];
  const { run, carved, stale, nodeRun } = planRun({ packages, carveOuts });

  // FAIL-CLOSED: a vacuous pass would silently recreate cinatra#2288.
  if (packages.length === 0) {
    findings.push({
      kind: "no-packages",
      message: "no extension packages materialized under extensions/ — clone-back failed; refusing to pass vacuously.",
    });
    return { findings, notices, run, carved, stale, nodeRun };
  }
  if (run.length + carved.length === 0) {
    findings.push({
      kind: "no-suites",
      message: `discovered ${packages.length} materialized package(s) but ZERO vitest suites — the classifier or the clone-back is broken; refusing to pass vacuously.`,
    });
    return { findings, notices, run, carved, stale, nodeRun };
  }

  // A stale entry grants no exemption, so it cannot weaken enforcement — it is
  // bookkeeping. Reporting it as a NOTICE keeps the automated dev-lock bump PR
  // (the very PR that retires these entries) from being blocked on a comment
  // edit, while still making the debt visible on every run.
  for (const { carveOut, why } of stale) {
    notices.push({
      kind: "stale-carve-out",
      slug: carveOut.id,
      message: `carve-out for "${carveOut.id}" no longer applies: ${why}. Delete its CARVE_OUTS entry in scripts/ci/extension-suite-gate.mjs.`,
    });
  }

  // A LOST report is fatal for EVERY package, enforced or carved, and is
  // checked before any tolerance. Without this the two blog carve-outs — whose
  // documented shape is "exit 1, 0 failures, sole file uncollected" — would be
  // satisfied exactly by a vanished report, so a broken reporter would read as
  // the defect they record.
  for (const pkg of [...run, ...carved]) {
    const res = results.get(pkg.id);
    if (res && res.reportOk === false) {
      findings.push({
        kind: "no-report",
        slug: pkg.slug,
        message: `${pkg.id}: vitest produced no parseable JSON report (exit ${res.exitCode}) — the run cannot be judged, and an absent report must never read as an expected result.`,
      });
    }
  }
  for (const pkg of nodeRun) {
    const res = results.get(pkg.id);
    if (res && res.reportOk === false) {
      const killed = res.timedOutFiles ?? [];
      const notStarted = res.notStartedFiles ?? [];
      const parts = [];
      if (killed.length) parts.push(`was still running at its bound and was killed for ${killed.join(", ")}`);
      if (notStarted.length) parts.push(`was not started before the gate's node:test deadline for ${notStarted.join(", ")}`);
      findings.push({
        kind: "no-report",
        slug: pkg.slug,
        message: parts.length
          ? `${pkg.id}: \`node --test\` ${parts.join("; it ")} — the run did not finish, so it cannot be judged.`
          : `${pkg.id}: a \`node --test\` run printed no TAP summary (exit ${res.exitCode}) — the run cannot be judged, and an absent summary must never read as zero failures.`,
      });
    }
  }
  const lostReport = new Set(findings.filter((f) => f.kind === "no-report").map((f) => f.slug));

  // Enforced set: green AND complete, or it blocks.
  for (const pkg of run) {
    if (lostReport.has(pkg.slug)) continue;
    const res = results.get(pkg.id);
    if (!res) {
      findings.push({ kind: "not-run", slug: pkg.slug, message: `${pkg.id}: discovered as a vitest suite but never executed.` });
      continue;
    }
    if (!res.ok) {
      findings.push({
        kind: "suite-red",
        slug: pkg.slug,
        message: `${pkg.id}: suite FAILED (exit ${res.exitCode}, ${res.numFailedTests ?? "?"} failing test(s)).`,
      });
      continue;
    }
    const missing = observedShape(pkg, res).uncollected;
    if (missing.length > 0) {
      findings.push({
        kind: "uncollected-files",
        slug: pkg.slug,
        message:
          `${pkg.id}: ${missing.length} on-disk test file(s) were NOT executed by vitest — ` +
          `${missing.join(", ")}. A green run that silently collects nothing is the cinatra#2288 defect itself; ` +
          `give the package its own vitest.config.ts (or widen its include) so every file runs. ` +
          `If an exclusion is genuinely deliberate, record it BY FILE in the CARVE_OUTS ledger's \`expect.uncollected\`.`,
      });
    }
  }

  // Carve-outs: tolerated ONLY for the exact shape they document, at the exact
  // sha they were written against (planRun already enforced the sha). Any other
  // shape — worse, different, or better — means the entry no longer describes
  // reality and must be re-derived by a human.
  for (const pkg of carved) {
    if (lostReport.has(pkg.slug)) continue;
    const res = results.get(pkg.id);
    if (!res) {
      findings.push({ kind: "not-run", slug: pkg.slug, message: `${pkg.id}: carved suite was never executed — a carve-out is run, not skipped.` });
      continue;
    }
    const actual = observedShape(pkg, res);
    if (shapeMatches(pkg.carveOut.expect, actual)) continue;
    findings.push({
      kind: "carve-out-shape-drift",
      slug: pkg.slug,
      message:
        `${pkg.id}: carve-out documents ${fmtShape({ ...pkg.carveOut.expect, uncollected: pkg.carveOut.expect.uncollected ?? [] })} ` +
        `at pin ${String(pkg.sha).slice(0, 12)}, but this run shows ${fmtShape(actual)}. ` +
        `A carve-out tolerates ONE documented defect, not whatever the package does next — ` +
        `re-derive the entry (or delete it if the suite is now green and complete).`,
    });
  }

  // The node:test suites only this gate runs: enforced like the vitest set —
  // green, and every on-disk test file executed with at least one test — or it
  // blocks. No ledger entry applies to them (planRun).
  for (const pkg of nodeRun) {
    if (lostReport.has(pkg.slug)) continue;
    const res = results.get(pkg.id);
    if (!res) {
      findings.push({
        kind: "not-run",
        slug: pkg.slug,
        message: `${pkg.id}: its own ci.yml skips its node:test suite as run by the host, and this gate never executed it.`,
      });
      continue;
    }
    if (!res.ok) {
      findings.push({
        kind: "suite-red",
        slug: pkg.slug,
        message: `${pkg.id}: node:test suite FAILED (exit ${res.exitCode}, ${res.numFailedTests ?? "?"} failing test(s)).`,
      });
      continue;
    }
    const missing = observedShape(pkg, res).uncollected;
    if (missing.length > 0) {
      findings.push({
        kind: "uncollected-files",
        slug: pkg.slug,
        message:
          `${pkg.id}: ${missing.length} on-disk test file(s) ran no test under \`node --test\` — ${missing.join(", ")}. ` +
          `A file that registers nothing proves nothing; name node:test in it or remove it.`,
      });
    }
  }

  // AC6: the companion skip may never outrun what the host actually does.
  const gated = new Set([...run, ...carved, ...nodeRun].map((p) => p.id));
  for (const pkg of packages) {
    if (pkg.testFiles.length === 0) continue;
    if (!pkg.standaloneTestsSkipped) continue;
    if (gated.has(pkg.id)) continue;
    findings.push({
      kind: "dishonest-skip",
      slug: pkg.slug,
      message:
        `${pkg.id}: its own ci.yml skips standalone tests because "the cinatra monorepo runs these", but this gate does NOT run its ` +
        `${pkg.testFiles.length} test file(s) (runner=${pkg.runner}). Either gate it here or stop claiming the host runs it.`,
    });
  }

  // CHECK 5: an "other" verdict must REST on something. A package with test
  // files, no vitest signal and no recognized runner named in any of them is
  // not "somebody else's suite" — it is a package this gate declined to run for
  // a reason it cannot state. Left alone it would sit in the manifest under
  // `its own CI runs <script>`, a claim nothing verified, which is precisely the
  // written-but-unchecked premise cinatra#2288 is about. Fires only where
  // `dishonest-skip` does not already fail the build, so a package is named
  // once, by the sharper rule.
  for (const pkg of packages) {
    if (pkg.runner !== "other") continue;
    if (pkg.runnerEvidence !== "unknown") continue;
    if (pkg.standaloneTestsSkipped) continue;
    findings.push({
      kind: "unidentified-runner",
      slug: pkg.slug,
      message:
        `${pkg.id}: ships ${pkg.testFiles.length} test file(s) (${pkg.testFiles.join(", ")}) but declares NO vitest suite ` +
        `(no config, no vitest in \`test\`, no vitest dependency, no vitest import) and names no recognized runner in any of them. ` +
        `This gate cannot run it and cannot verify anything else does — its \`test\` script is \`${pkg.testScript}\`, which is a claim, not a proof. ` +
        `Give the package a vitest config (or a vitest import) so it is gated here, or make its runner explicit in the test sources.`,
    });
  }

  return { findings, notices, run, carved, stale, nodeRun };
}

/** Fixed-width manifest of the WHOLE materialized fleet. */
export function renderManifest({ packages, results, carveOuts = CARVE_OUTS }) {
  const { carved, nodeRun } = planRun({ packages, carveOuts });
  const carvedIds = new Set(carved.map((p) => p.id));
  const nodeRunIds = new Set(nodeRun.map((p) => p.id));
  const lines = [];
  const w = Math.max(24, ...packages.map((p) => p.slug.length));
  lines.push(
    `${"package".padEnd(w)}  ${"runner".padEnd(7)} ${"files".padStart(5)} ${"ran".padStart(4)} ${"tests".padStart(6)} ${"secs".padStart(6)}  status`,
  );
  lines.push("-".repeat(w + 42));
  for (const p of [...packages].sort((a, b) => a.slug.localeCompare(b.slug))) {
    const res = results?.get(p.id);
    let status;
    if (p.runner === "none") status = "no test files";
    else if (nodeRunIds.has(p.id)) {
      // Its repo skips its tests, so this gate runs them with node --test.
      if (!res) status = "node:test here — NOT RUN";
      else if (res.timedOutFiles?.length || res.notStartedFiles?.length) {
        const n = res.notStartedFiles?.length ?? 0;
        status = `node:test here — TIMED OUT (${res.timedOutFiles?.length ?? 0} file(s) killed${n ? `, ${n} not started before the deadline` : ""})`;
      }
      else if (res.reportOk === false) status = `node:test here — NO REPORT (exit ${res.exitCode})`;
      else if (!res.ok) status = `node:test here — RED (exit ${res.exitCode})`;
      else {
        const executed = new Set(res.executedFiles);
        const missing = p.testFiles.filter((f) => !executed.has(f)).length;
        status = missing ? `node:test here — INCOMPLETE (${missing} file(s) ran no test)` : "node:test here — ok";
      }
    } else if (p.runner === "other") {
      status = p.standaloneTestsSkipped
        ? "NOT GATED — its repo skips tests too"
        : p.runnerEvidence === "unknown"
          ? "UNIDENTIFIED RUNNER — no vitest signal, no runner named (see error above)"
          : `node:test; its own CI runs \`${p.testScript}\``;
    } else if (carvedIds.has(p.id)) {
      const entry = carveOuts.find((c) => c.id === p.id);
      if (!res) status = "CARVED (not run)";
      else if (shapeMatches(entry?.expect, observedShape(p, res))) status = "CARVED (documented defect, at pin; see ledger)";
      else status = "CARVED — SHAPE DRIFT (see error above)";
    } else if (!res) status = "NOT RUN";
    else if (!res.ok) status = `RED (exit ${res.exitCode})`;
    else {
      const executed = new Set(res.executedFiles);
      const missing = p.testFiles.filter((f) => !executed.has(f)).length;
      status = missing ? `INCOMPLETE (${missing} file(s) not executed)` : "ok";
    }
    lines.push(
      `${p.slug.padEnd(w)}  ${p.runner.padEnd(7)} ${String(p.testFiles.length).padStart(5)} ` +
        `${String(res?.executedFiles?.length ?? "-").padStart(4)} ${String(res?.numTotalTests ?? "-").padStart(6)} ` +
        `${(res ? (res.durationMs / 1000).toFixed(1) : "-").padStart(6)}  ${status}`,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// IO + CLI
// ---------------------------------------------------------------------------

function walkTestFiles(dir) {
  const out = [];
  const stack = [""];
  while (stack.length) {
    const rel = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!WALK_SKIP_DIRS.has(e.name)) stack.push(childRel);
      } else if (e.isFile() && TEST_FILE_RE.test(e.name)) {
        out.push(childRel);
      }
    }
  }
  return out.sort();
}

// The clone-back checks every companion out DETACHED at its committed lock
// pin, so HEAD here IS the pin the run is validating. Read it straight off the
// working tree rather than off the lock file: what actually ran is what matters
// for binding a carve-out, and the two could disagree if a sync half-failed.
//
// The three git reads are handed to the PURE resolveMaterializedSha above,
// which is what refuses a HEAD that belongs to the host repo rather than to the
// package. Any git failure degrades to "identity unavailable", which enforces
// the package rather than exempting it.
const git = (dir, args) => {
  try {
    return execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

function readMaterializedIdentity(pkgDir) {
  return resolveMaterializedSha({
    pkgDir,
    toplevel: git(pkgDir, ["rev-parse", "--show-toplevel"]),
    head: git(pkgDir, ["rev-parse", "HEAD"]),
    // Tracked-file modifications only. `--porcelain` alone would also report
    // UNTRACKED files, and the host tree legitimately grows those inside a
    // package (a node_modules/, a stray build output) without changing one byte
    // of the committed content a carve-out is written against.
    status: git(pkgDir, ["status", "--porcelain", "--untracked-files=no"]),
  });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function discover(repoRoot) {
  const extRoot = path.join(repoRoot, "extensions");
  const packages = [];
  let scopes = [];
  try {
    scopes = fs.readdirSync(extRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return packages;
  }
  for (const scope of scopes) {
    const scopeDir = path.join(extRoot, scope.name);
    for (const d of fs.readdirSync(scopeDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const dir = path.join(scopeDir, d.name);
      const pkgJson = readJson(path.join(dir, "package.json"));
      if (!pkgJson) continue;
      const testFiles = walkTestFiles(dir);
      const { sha, dirty } = readMaterializedIdentity(dir);
      let ciWorkflow = "";
      try {
        ciWorkflow = fs.readFileSync(path.join(dir, ".github/workflows/ci.yml"), "utf8");
      } catch {
        ciWorkflow = "";
      }
      packages.push(
        classifyPackage({
          slug: d.name,
          id: `${scope.name}/${d.name}`,
          sha,
          dirty,
          dir: path.relative(repoRoot, dir),
          pkgJson,
          entries: fs.readdirSync(dir),
          testFiles,
          readTestSource: (f) => {
            try {
              return fs.readFileSync(path.join(dir, f), "utf8");
            } catch {
              return "";
            }
          },
          ciWorkflow,
        }),
      );
    }
  }
  return packages.sort((a, b) => a.slug.localeCompare(b.slug));
}

function runVitest({ repoRoot, pkg, reportDir, slot }) {
  return new Promise((resolve) => {
    // INJECTIVE by construction: a sanitized id is not (two ids differing only
    // in a stripped character would collide and one suite would read the
    // other's report). The slot index is unique per run, the id is kept only
    // for readability.
    const outFile = path.join(reportDir, `${slot}-${pkg.id.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
    const started = Date.now();
    // ONE inner worker per package, because the OUTER pool already sets the
    // concurrency budget: without a cap, each of the N concurrent vitest
    // processes spins its own worker pool sized to the core count, so a 4-core
    // runner runs ~16 workers and the measured wall time stops meaning
    // anything.
    //
    // Via env and NOT `--maxWorkers`: the
    // fleet does not run one vitest. Nine artifact packages resolve their own
    // pinned vitest 2.x, where `--maxWorkers=1` collides with that version's
    // default minThreads and the run dies with `options.minThreads and
    // options.maxThreads must not conflict` — a RangeError that reports as a
    // red suite with ZERO executed files. Verified across both majors on the
    // materialized tree. Setting BOTH bounds is what keeps them consistent.
    //
    // Raw `vitest run`, NOT the package's `pnpm test`, is deliberate and is
    // what the eight hand-listed steps this replaces already did: the fleet's
    // test scripts are not uniform (several are a bare `vitest`, i.e. WATCH
    // mode; others shell out to `node scripts/test.mjs`), so invoking them
    // would make the gate's behaviour depend on 44 divergent scripts. Each
    // package's own vitest CONFIG is still fully honoured — that is what makes
    // the aliases and environments work.
    const child = spawn(
      "pnpm",
      [
        "exec",
        "vitest",
        "run",
        "--no-coverage",
        // Same 30s the HOST root config already grants its own suite, for the
        // same measured reason, quoted there: several guards are repo-wide
        // SOURCE SCANNERS whose filesystem walk gets starved under load and
        // trips vitest's 5s default. That is not hypothetical here — running
        // these 44 suites concurrently reproduced it in gmail-connector's
        // `no-direct-send-bypass` import-ban scan, which times out at 5000ms
        // after ~6.5s of walking while three sibling suites compete for the
        // runner. It masks nothing: a genuinely hung unit test still fails, 25
        // seconds later.
        "--testTimeout=30000",
        "--reporter=default",
        "--reporter=json",
        `--outputFile=${outFile}`,
      ],
      {
        cwd: path.join(repoRoot, pkg.dir),
        env: {
          ...process.env,
          CI: "1",
          FORCE_COLOR: "0",
          // ONE inner worker per package, spelled for BOTH vitest majors on the
          // tree. They do not share an env contract: vitest 4 reads
          // VITEST_MAX_WORKERS and nothing else, while vitest 2 (which nine
          // artifact packages pin) reads VITEST_{MIN,MAX}_{THREADS,FORKS}.
          // Verified by grepping each installed major's dist. Setting only the
          // v2 names — as this first did — left the v4 majority uncapped, which
          // is how the oversubscription these comments claim to prevent
          // survived a measurement that looked fine.
          VITEST_MAX_WORKERS: "1",
          VITEST_MIN_THREADS: "1",
          VITEST_MAX_THREADS: "1",
          VITEST_MIN_FORKS: "1",
          VITEST_MAX_FORKS: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let buf = "";
    const cap = (chunk) => {
      buf += chunk;
      if (buf.length > 400_000) buf = buf.slice(-400_000);
    };
    child.stdout.on("data", cap);
    child.stderr.on("data", cap);
    child.on("error", (err) =>
      resolve({
        ok: false,
        exitCode: -1,
        reportOk: false,
        executedFiles: [],
        durationMs: Date.now() - started,
        detail: String(err),
      }),
    );
    child.on("close", (code) => {
      const pkgDir = path.join(repoRoot, pkg.dir);
      const report = readJson(outFile);
      const parsed = parseReport({
        report,
        pkgDir,
        relativize: (from, to) => path.relative(from, to),
      });
      resolve({
        ok: code === 0,
        exitCode: code,
        // Whether the JSON reporter actually produced a parseable report. A
        // LOST report is indistinguishable from "ran nothing" once parsed, and
        // for a carve-out recording an uncollected file that absence would
        // MATCH the exemption exactly. Carried explicitly so the rules can
        // refuse it instead of tolerating it.
        reportOk: report !== null && Array.isArray(report.testResults),
        ...parsed,
        durationMs: Date.now() - started,
        detail: buf,
      });
    });
  });
}

// The bounds of one `node --test` file run. A test is cancelled after the same
// 30 s the vitest road grants (`--testTimeout=30000` above), and node exits once
// the file's tests have ended even when the file left a timer or a socket open
// (`--test-force-exit`). The file bound is this
// gate's own: a file still running after it (a synchronous loop, which no test
// timeout can interrupt) has its process group killed and is reported as timed
// out, so a hung file is ended after the bound instead of holding the job until
// the workflow's own timeout.
//
// The files run one after another, so the file bound alone does not bound the
// node:test phase: six files that each reach it take 30 minutes. The phase
// therefore also has a deadline, NODE_GATE_DEADLINE_MS after the gate started:
// a file still running at it is killed, a file not yet started is not started,
// both are reported as `no-report`, and the manifest is still printed. The job
// that runs this gate ("Perpetual extension suites (discovery gate shard)" in
// .github/workflows/build-image.yml) has `timeout-minutes: 27`; its steps before
// the gate (checkout, pnpm, node, the companion clones and the install) took
// 74 s at cinatra#4425's fifth commit, so the 20 minutes leave 7 minutes for
// that setup, the wait for the last killed file to close (NODE_KILL_GRACE_MS),
// the manifest and the post steps. The vitest phase runs first and counts
// against the deadline, but this gate does not stop a vitest run.
// EXTENSION_SUITE_NODE_DEADLINE_MS can only shorten the deadline (see
// nodeGateDeadlineMs). After a kill, the gate waits for the child's close up to
// NODE_KILL_GRACE_MS before it reads the records and removes their folder.
export const NODE_TEST_TIMEOUT_MS = 30_000;
export const NODE_FILE_TIMEOUT_MS = 300_000;
export const NODE_GATE_DEADLINE_MS = 20 * 60_000;
export const NODE_KILL_GRACE_MS = 10_000;
const NODE_STDOUT_CAP = 400_000;
const NODE_STDERR_CAP = 100_000;

// The TAP goes to stdout. A second reporter, this script's default export,
// writes one JSON line per top-level test to `topLevelFile`: node reports a
// file that registers no test as one test named by the file's path, and the
// TAP of that report is the same as the TAP of a real test of that name. What
// differs is the location node gives it: line 1, column 1 of the file, where a
// real test is reported at the place of its call. A file written by the reporter is not
// mixed with what the tests print, which reaches the TAP as comments.
export function nodeTestArgs(file, topLevelFile, testTimeoutMs = NODE_TEST_TIMEOUT_MS) {
  return [
    "--test",
    "--test-reporter=tap",
    "--test-reporter-destination=stdout",
    `--test-reporter=${import.meta.url}`,
    `--test-reporter-destination=${topLevelFile}`,
    `--test-timeout=${testTimeoutMs}`,
    "--test-force-exit",
    file,
  ];
}

// The second reporter (see nodeTestArgs): node loads this script as a module
// and uses its default export; `main` below runs only when the script is the
// program itself.
export default async function* nodeTopLevelReporter(source) {
  for await (const event of source) {
    if ((event.type === "test:pass" || event.type === "test:fail") && event.data.nesting === 0) {
      yield `${JSON.stringify({ name: event.data.name, line: event.data.line ?? null, column: event.data.column ?? null })}\n`;
    }
  }
}

// The lines nodeTopLevelReporter wrote; a missing file or a line that is not
// such a record gives nothing, which parseNodeTap reads in the safe direction.
export function readTopLevel(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    try {
      const r = JSON.parse(line);
      if (r && typeof r.name === "string") out.push({ name: r.name, line: r.line, column: r.column });
    } catch {
      // not a record
    }
  }
  return out;
}

// The deadline of the node:test phase in ms after the gate started. A positive
// integer in EXTENSION_SUITE_NODE_DEADLINE_MS below the default replaces it (the
// kit cases use a short one); any other value, or none, keeps the default, so
// the variable can only shorten the deadline. Exported for its test.
export function nodeGateDeadlineMs(env = process.env) {
  const v = Number(env.EXTENSION_SUITE_NODE_DEADLINE_MS);
  return Number.isInteger(v) && v > 0 && v < NODE_GATE_DEADLINE_MS ? v : NODE_GATE_DEADLINE_MS;
}

// The node:test children now running, by pid, with their record folders, so a
// signal to the gate can end them (installNodeRunCleanup).
const liveNodeRuns = new Map();

// The pid and record folder of each node:test child now running. Exported for its test.
export function listLiveNodeRuns() {
  return [...liveNodeRuns.entries()].map(([pid, { recDir }]) => ({ pid, recDir }));
}

// Kill the process group of a child that was started with `detached: true`; if
// the group kill fails, kill the child alone. Returns what was done, for the
// detail line: "group", "leader", or "failed".
function killNodeGroup(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
    return "group";
  } catch {
    try {
      return child.kill("SIGKILL") ? "leader" : "failed";
    } catch {
      return "failed";
    }
  }
}

// End every running node:test child (its whole process group) and remove its
// record folder. Returns one entry per child. Exported for its test.
export function stopLiveNodeRuns() {
  const out = [];
  for (const [pid, run] of liveNodeRuns) {
    out.push({ pid, kill: killNodeGroup(run.child), recDir: run.recDir });
    fs.rmSync(run.recDir, { recursive: true, force: true });
  }
  liveNodeRuns.clear();
  return out;
}

// In `main`: a SIGTERM or SIGINT to the gate (a cancelled or timed-out job) ends
// the running node:test children and removes their record folders before the
// gate exits with the signal's usual code. Exported for its test.
export function installNodeRunCleanup(proc = process) {
  for (const [sig, code] of [
    ["SIGTERM", 143],
    ["SIGINT", 130],
  ]) {
    proc.once(sig, () => {
      stopLiveNodeRuns();
      proc.exit(code);
    });
  }
}

// One `node --test` process per test file, in the package's own directory, so a
// file that registers nothing is visible as such instead of being hidden in a
// package total. The TAP and the top-level records are what parseNodeTap reads;
// the package's `test` script is not used, for the same reason runVitest does
// not use it. A child that cannot start resolves as exit -1 with no TAP. A child
// still running at the file bound, or at `deadlineAt` when that comes first, has
// its process group killed; the run resolves as exit -1 with `timedOut: true`
// after the child's close (or after NODE_KILL_GRACE_MS without one, noted in the
// detail), and only then are the records read and their folder removed.
// foldNodeRuns reads both endings as a lost report. Exported for its test, with
// the bounds as parameters so the test can use short ones, and the spawn as one
// so the test can give a child that never closes or cannot be killed.
export function runNodeTestFile({
  cwd,
  file,
  testTimeoutMs = NODE_TEST_TIMEOUT_MS,
  fileTimeoutMs = NODE_FILE_TIMEOUT_MS,
  deadlineAt = Infinity,
  killGraceMs = NODE_KILL_GRACE_MS,
  spawnChild = spawn,
}) {
  return new Promise((resolve) => {
    // NODE_TEST_CONTEXT would make the child report to a parent test runner
    // instead of printing its own TAP; it is dropped so the summary is printed.
    const env = { ...process.env, CI: "1", FORCE_COLOR: "0" };
    delete env.NODE_TEST_CONTEXT;
    let out = "";
    let err = "";
    let timer;
    let graceTimer;
    let killed = null;
    let settled = false;
    let child;
    const recDir = fs.mkdtempSync(path.join(os.tmpdir(), "ext-suite-node-"));
    const recFile = path.join(recDir, "top-level.jsonl");
    const finish = (run) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      if (child?.pid) liveNodeRuns.delete(child.pid);
      let rec = "";
      try {
        rec = fs.readFileSync(recFile, "utf8");
      } catch {
        // no record file: the run wrote none
      }
      fs.rmSync(recDir, { recursive: true, force: true });
      resolve({ ...run, recDir, topLevel: readTopLevel(rec) });
    };
    const killedRun = (closed) => {
      const note =
        `[extension-suite-gate] ${file} was still running ${killed.why} and was killed (kill: ${killed.how}` +
        `${closed ? ", closed" : `, no close within ${killGraceMs} ms`})`;
      return { file, exitCode: -1, tap: out, timedOut: true, pid: child.pid, kill: killed.how, closed, detail: `${out}${err}\n${note}` };
    };
    // Its own process group, so the kill below also reaches the processes a test
    // started in that group.
    try {
      child = spawnChild(process.execPath, nodeTestArgs(file, recFile, testTimeoutMs), {
        cwd,
        env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });
    } catch (e) {
      finish({ file, exitCode: -1, tap: "", detail: String(e) });
      return;
    }
    if (child.pid) liveNodeRuns.set(child.pid, { child, recDir });
    child.stdout.on("data", (c) => {
      out += c;
      if (out.length > NODE_STDOUT_CAP) out = out.slice(-NODE_STDOUT_CAP);
    });
    child.stderr.on("data", (c) => {
      err += c;
      if (err.length > NODE_STDERR_CAP) err = err.slice(-NODE_STDERR_CAP);
    });
    const byDeadline = deadlineAt - Date.now() < fileTimeoutMs;
    const bound = Math.max(0, Math.min(fileTimeoutMs, deadlineAt - Date.now()));
    timer = setTimeout(() => {
      killed = {
        how: killNodeGroup(child),
        why: byDeadline ? "at the gate's node:test deadline" : `after ${fileTimeoutMs} ms`,
      };
      graceTimer = setTimeout(() => finish(killedRun(false)), killGraceMs);
    }, bound);
    child.on("error", (e) => finish({ file, exitCode: -1, tap: "", detail: String(e) }));
    child.on("close", (code) => finish(killed ? killedRun(true) : { file, exitCode: code, tap: out, detail: out + err }));
  });
}

// The files of one package, one after another, folded into one result. A file
// not started because `deadlineAt` has passed is recorded as `notStarted`.
// Exported for its test.
export async function runNodeTest({ repoRoot, pkg, testTimeoutMs, fileTimeoutMs, deadlineAt = Infinity, killGraceMs }) {
  const started = Date.now();
  const cwd = path.join(repoRoot, pkg.dir);
  const files = [];
  for (const file of pkg.testFiles) {
    if (Date.now() >= deadlineAt) {
      files.push({ file, exitCode: -1, tap: "", notStarted: true, detail: "[extension-suite-gate] not started: the gate's node:test deadline had passed" });
      continue;
    }
    files.push(await runNodeTestFile({ cwd, file, testTimeoutMs, fileTimeoutMs, deadlineAt, killGraceMs }));
  }
  const how = (f) => (f.notStarted ? ", not started" : f.timedOut ? ", killed" : "");
  return {
    ...foldNodeRuns(files),
    durationMs: Date.now() - started,
    detail: files.map((f) => `--- node --test ${f.file} (exit ${f.exitCode}${how(f)})\n${f.detail}`).join("\n"),
  };
}

// Run the node:test packages and add their results to the vitest results map,
// keyed by the same scope-qualified id. Exported for its test.
export async function runNodeSuites({ repoRoot, nodeRun, jobs, results, log = console.log, testTimeoutMs, fileTimeoutMs, deadlineAt = Infinity, killGraceMs }) {
  if (nodeRun.length === 0) return results;
  log(`\n[extension-suite-gate] running ${nodeRun.length} node:test suite(s) whose own CI skips them...\n`);
  const nodeResults = await pool(nodeRun, jobs, async (pkg) => {
    const res = await runNodeTest({ repoRoot, pkg, testTimeoutMs, fileTimeoutMs, deadlineAt, killGraceMs });
    log(
      `::group::${res.ok ? "PASS" : "FAIL"} ${pkg.id} [node:test] (${(res.durationMs / 1000).toFixed(1)}s, ` +
        `${res.executedFiles.length}/${pkg.testFiles.length} file(s))`,
    );
    log(fenceWorkflowCommands(res.detail).trimEnd());
    log("::endgroup::");
    return res;
  });
  for (const [id, res] of nodeResults) results.set(id, res);
  return results;
}

async function pool(items, limit, worker) {
  const out = new Map();
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out.set(items[i].id, await worker(items[i]));
    }
  });
  await Promise.all(runners);
  return out;
}

// Companion test output is UNTRUSTED text. A suite that prints a line starting
// with `::` would otherwise be issuing real GitHub workflow commands from
// inside this gate's own log — forging an ::error::, closing the ::group:: that
// frames it, or setting an output. Neutering the leading marker keeps the
// printed manifest a statement made by THIS gate rather than by the code it
// runs.
export function fenceWorkflowCommands(text) {
  return String(text).replace(/^(\s*)::/gm, "$1\u2063::");
}

async function main() {
  const startedAt = Date.now();
  const repoRoot = process.cwd();
  const listOnly = process.argv.includes("--list");
  const jobs = Math.max(1, Number(process.env.EXTENSION_SUITE_JOBS || Math.min(4, os.availableParallelism?.() ?? 4)));

  const packages = discover(repoRoot);
  const { run, carved, stale, nodeRun } = planRun({ packages });

  console.log(
    `[extension-suite-gate] discovered ${packages.length} materialized package(s): ` +
      `${run.length} vitest suite(s) enforced, ${carved.length} carved out (at pin), ` +
      `${packages.filter((p) => p.runner === "other").length} non-vitest ` +
      `(${nodeRun.length} of them node:test suites run here because their own CI skips them), ` +
      `${packages.filter((p) => p.runner === "none").length} with no test files.`,
  );

  let results = new Map();
  if (!listOnly) {
    const reportDir = fs.mkdtempSync(path.join(os.tmpdir(), "ext-suite-gate-"));
    const toRun = [...run, ...carved];
    console.log(`[extension-suite-gate] running ${toRun.length} suite(s), ${jobs} at a time...\n`);
    results = await pool(toRun, jobs, async (pkg) => {
      const res = await runVitest({ repoRoot, pkg, reportDir, slot: toRun.indexOf(pkg) });
      console.log(
        `::group::${res.ok ? "PASS" : "FAIL"} ${pkg.id} (${(res.durationMs / 1000).toFixed(1)}s, ` +
          `${res.executedFiles.length}/${pkg.testFiles.length} file(s))`,
      );
      console.log(fenceWorkflowCommands(res.detail).trimEnd());
      console.log("::endgroup::");
      return res;
    });
    fs.rmSync(reportDir, { recursive: true, force: true });
    installNodeRunCleanup();
    await runNodeSuites({ repoRoot, nodeRun, jobs, results, deadlineAt: startedAt + nodeGateDeadlineMs() });
  }

  console.log("\n[extension-suite-gate] MANIFEST (every materialized package; nothing here is silent)\n");
  console.log(renderManifest({ packages, results }));

  if (carved.length > 0) {
    console.log("\n[extension-suite-gate] CARVE-OUTS IN EFFECT (named, pinned, shape-bound, still run)");
    for (const p of carved) {
      console.log(`  - ${p.id} @ ${String(p.sha).slice(0, 12)} — tolerating exactly: ${fmtShape({ ...p.carveOut.expect, uncollected: p.carveOut.expect.uncollected ?? [] })}`);
      console.log(`      why:      ${p.carveOut.reason}`);
      console.log(`      upstream: ${p.carveOut.upstream}`);
      console.log(`      retires:  ${p.carveOut.retiresWhen}`);
    }
  }
  if (stale.length > 0) {
    console.log("\n[extension-suite-gate] LEDGER ENTRIES NO LONGER IN EFFECT (their packages are enforced)");
    for (const { carveOut, why } of stale) console.log(`  - ${carveOut.id}: ${why}`);
  }

  if (listOnly) return;

  const { findings, notices } = judge({ packages, results });
  const totalTests = [...results.values()].reduce((n, r) => n + (r.numTotalTests ?? 0), 0);
  const totalSecs = [...results.values()].reduce((n, r) => n + r.durationMs, 0) / 1000;
  console.log(
    `\n[extension-suite-gate] ${totalTests} test(s) across ${results.size} suite(s); ` +
      `${totalSecs.toFixed(1)}s of suite time at ${jobs}-way concurrency.`,
  );

  for (const n of notices) console.log(`::notice title=extension-suite-gate::${n.message}`);

  if (findings.length === 0) {
    console.log("[extension-suite-gate] OK — every enforced extension suite ran, complete and green.");
    return;
  }
  for (const f of findings) console.log(`::error title=extension-suite-gate::${f.message}`);
  console.log(`\n[extension-suite-gate] FAILED with ${findings.length} finding(s).`);
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
