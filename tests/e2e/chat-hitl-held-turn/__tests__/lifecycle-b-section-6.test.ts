// PLAN (B) §6 — the acceptance clauses this epic's merged waves already carry,
// and the four nothing on `main` was checking (cinatra#2936, epic #2926 W6).
//
// WHERE THIS RUNS, AND WHY HERE. #2936 asks for the §6 fixtures "inside the
// held-turn harness S9k builds rather than a second harness". That harness is
// `tests/e2e/config/chat-hitl-held-turn.config.ts` and the suite beside this
// file; its Playwright projects are the ones that boot a dev runtime with the
// scripted provider. The harness ALSO has a unit annex — this directory —
// which that config excludes from Playwright (`testIgnore: ["**/__tests__/**"]`)
// and which the ROOT vitest include picks up by the one glob it grants under
// `tests/e2e/` (`tests/e2e/chat-hitl-held-turn/__tests__/**/*.test.ts`). So a
// §6 clause that is a claim about SOURCE SHAPE or about a recorded gap runs
// here, in the harness, with no second harness invented for it; a clause that
// can only be observed on a screen belongs to a project of that same config.
// `state-rules.test.ts` beside this file is the precedent.
//
// WHAT IS COVERED HERE, AND WHAT IS NOT. Four clauses, each of which had no
// fixture running in CI before this file:
//
//   A. "A waiting run's row states its moment, card kind and card reference …
//      and no screen re-derives a moment" (§6 The runner).
//   B. "A conversation whose model cannot use tools says so when asked to act;
//      the buttons still work; no silent no-op" (§6 One road) — the CONFINEMENT
//      half only; see that describe for what it does and does not prove.
//   C. "the schedule moment is shown for every run a person starts …" (§6 The
//      runner) — the DECISION half is met (cinatra#2936): the schedule default
//      has its consumer and one statement, asserted below. The clause's other
//      half — that the moment is SHOWN on all three hosts — is an observation
//      about screens and stays recorded as owed.
//   D. "Every fixture named in plan section 6 … run … inside the held-turn
//      harness rather than a second harness" (cinatra#2936) — four of this
//      plan's own waves shipped their proof in a private
//      `vitest.integration-*.config.ts` tier no workflow invoked. RECORDED as a
//      gap when this file landed; CLOSED in the same slice's CI change, which
//      made all four steps OF THIS HARNESS'S OWN JOB — the clause's "rather
//      than a second harness", read as it is written — and taught
//      `scripts/audit/ci-pinned-tests-exist.mjs` (direction 4) to fail on the
//      next root tier that arrives unwired anywhere. D's arm below now asserts
//      the guarantee rather than the gap: the correction the arm asked for, in
//      the place it asked for it.
//
// NEITHER RECORD IS A WAIVER, AND BOTH ARE NOW LIVE ASSERTIONS. C and D were
// each written in the shape this repo already uses for owed work
// (`UNROUTED_PRODUCERS`, the host-parity ratchet's `owed` rows): a LIVE arm that
// reds the moment the gap closes, so the record cannot go stale. Both arms did
// exactly what they were written to do. C's went red the moment a consumer
// appeared (cinatra#2936); it is now the positive assertion of the decision
// half, and it is live in both directions — a second statement of the decision
// reds it, and so does a surface that stops reading it. What is still owed under
// C is the screen observation, and it keeps a NARROWED skipped arm carrying that
// remainder of the clause. D's is closed outright: its arm asserts the guarantee
// — all four tiers as steps of this harness's own job — rather than the gap.
//
// FAIL-CLOSED, AND ITS RESIDUALS NAMED. Four of the assertions below are
// SOURCE SCANS, so each one's reach is finite. Every residual is stated at the arm it belongs to
// rather than left for a reader to discover, and each scan is written so an
// unmodelled spelling costs a MISSED violation a wider arm can add later, never
// a false green about something it did check. None of them replaces the
// behavioural coverage they cite.
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { LIFECYCLE_MOMENTS } from "@cinatra-ai/agent-ui-protocol/renderable-views";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");

/**
 * Every shipped source file, repo-relative and POSIX-spelled.
 *
 * PRODUCT ONLY: a `__tests__` directory is excluded, because a test naming a
 * heuristic in order to assert it absent is not a surface re-deriving anything.
 * Fixture, stub and build directories are excluded for the same reason. The
 * walk is enumerated from two roots rather than the repo root so a stray
 * checkout artefact cannot silently widen it.
 */
const SOURCE_ROOTS = ["src", "packages"] as const;
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  "__tests__",
  "__fixtures__",
  "__stubs__",
  "__mocks__",
  "generated",
  ".next",
  "dist",
  "build",
  "coverage",
]);
/** Every module extension this tree ships a SCREEN or a server module in. */
const SOURCE_EXTENSIONS = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function walkSources(): readonly string[] {
  const found: string[] = [];
  const visit = (absolute: string) => {
    for (const entry of readdirSync(absolute)) {
      if (SKIP_DIRECTORIES.has(entry)) continue;
      const child = path.join(absolute, entry);
      if (statSync(child).isDirectory()) {
        visit(child);
        continue;
      }
      if (!SOURCE_EXTENSIONS.test(entry)) continue;
      if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(entry)) continue;
      found.push(path.relative(REPO_ROOT, child).split(path.sep).join("/"));
    }
  };
  for (const root of SOURCE_ROOTS) visit(path.join(REPO_ROOT, root));
  return found;
}

const SOURCES = walkSources();

/** Repo-relative paths of every product file whose text matches `pattern`. */
function sourcesMatching(pattern: RegExp): readonly string[] {
  return SOURCES.filter((relative) => {
    const text = readFileSync(path.join(REPO_ROOT, relative), "utf8");
    // A fresh lastIndex per file: a /g/ regex is stateful across `.test`.
    pattern.lastIndex = 0;
    return pattern.test(text);
  }).sort();
}

const read = (relative: string) =>
  readFileSync(path.join(REPO_ROOT, relative), "utf8");

/**
 * A module's CODE, with EVERY comment removed — block comments, whole-line `//`
 * comments and TRAILING `//` comments alike.
 *
 * For an arm that claims a module still READS something, a plain text scan is a
 * false green waiting to happen: a commented-out import and a commented-out call
 * satisfy it exactly as the live ones would, which is the state a module is in
 * the moment someone retires an edge and leaves the lines behind. A trailing
 * comment is the same hole one column to the right, so the line scan below is a
 * quote-aware cut rather than a `startsWith` — `"https://…"` keeps its slashes
 * because the cut only fires outside a string.
 *
 * WHAT IT CANNOT DO: fabricate. Nothing here JOINS text the module kept apart —
 * a block comment is blanked in place rather than deleted, a trailing cut only
 * ever shortens its own line, and every pattern below matches within ONE line
 * (`[^\S\n]` where horizontal space is meant, never `\s`) — so no spelling can
 * appear that no single line carries.
 *
 * RESIDUALS, STATED, BECAUSE NOTHING HERE PARSES TYPESCRIPT. A `//` inside a
 * multi-line template or a regex literal reads as a comment start and DROPS real
 * code from the scan, which reds an arm that should pass. And an unbalanced
 * quote inside a regex literal — `/"/` — leaves the scan believing it is inside
 * a string, so a trailing comment on THAT line survives uncut and could answer
 * for code. Both are shapes neither scanned module has; a fixture that had to
 * rule them out would belong in the compiler's own tier, and neither residual
 * replaces the behavioural coverage this arm cites.
 */
const withoutComments = (source: string) => {
  const cutTrailing = (line: string) => {
    let quote: string | null = null;
    for (let i = 0; i < line.length; i += 1) {
      const character = line[i];
      if (quote !== null) {
        if (character === "\\") {
          i += 1;
          continue;
        }
        if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'" || character === "`") {
        quote = character;
        continue;
      }
      if (character === "/" && line[i + 1] === "/") return line.slice(0, i);
    }
    return line;
  };
  return source
    // BLANKED, NOT DELETED. A removed block comment would pull the text on
    // either side of it together — across newlines — and two fragments that
    // never touched in the module could spell a pattern between them. Replacing
    // every character except the newlines keeps every line and every column
    // where the module put them.
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .split("\n")
    .map(cutTrailing)
    .join("\n");
};

/**
 * Escape every RegExp metacharacter in a literal — the BACKSLASH included.
 *
 * One helper rather than a per-site `replace`: a partial escape (dots only, the
 * obvious case here) leaves a backslash in the input able to change the meaning
 * of the pattern built from it, which is a real defect even when today's inputs
 * are tame file names.
 */
const escapeForRegExp = (literal: string) =>
  literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const CLASSIFIER = "packages/agents/src/run-surface-status.ts";
const COORDINATOR = "packages/agents/src/lifecycle-coordinator.ts";
/** Where the tier-neutral lifecycle decisions are stated (cinatra#2936), and
 *  the two surfaces that draw a schedule. Listed in the order `sourcesMatching`
 *  sorts them, so an expectation reads like the answer it compares against. */
const REGISTRY =
  "packages/agent-ui-protocol/src/renderable-views/lifecycle-cards.ts";
const SCHEDULING_STEP = "packages/agents/src/trigger-screen-client.tsx";
const HELD_SCHEDULE_CARD = "src/lib/lifecycle/trigger-schedule-proposal-card.ts";
const MOMENT_SCHEMA = "src/lib/agent-run-lifecycle-moment-schema.ts";
const STORE = "src/lib/drizzle-store.ts";

// ---------------------------------------------------------------------------
// A. THE RUNNER — "A waiting run's row states its moment, card kind and card
//    reference; a wait for a setup field and a wait for a review are told apart
//    from the row alone, and no screen re-derives a moment."
// ---------------------------------------------------------------------------

describe("§6 The runner — no screen re-derives a moment", () => {
  it("the bootstrap really composes all three columns, not the moment alone", () => {
    // BOTH HALVES, because either alone is green for the wrong reason: the leaf
    // states three columns, and the store COMPOSES that leaf. A leaf nobody
    // spreads produces no column at all, and a spread of a leaf that lost a
    // statement produces two.
    //
    // Not a restatement for its own sake: the DB tier asserts the real result
    // against a live Postgres
    // (`src/lib/__tests__/agent-run-lifecycle-moment.integration.test.ts`), which
    // is reached through `pnpm test:lifecycle-moment` — a package script that ran
    // in no workflow when this file landed, and now runs as a step of this
    // harness's own job (the arm at the end of this file holds that open). This
    // scan is the SOURCE half of the same claim and keeps its own reader: it
    // names the two modules that must agree.
    const ddl = read(MOMENT_SCHEMA);
    for (const column of [
      "lifecycle_moment",
      "lifecycle_card_kind",
      "lifecycle_card_ref",
    ]) {
      expect(ddl, `${column} is not added by the leaf's DDL`).toContain(
        `ADD COLUMN IF NOT EXISTS ${column} text`,
      );
    }
    // THE SPREAD, not merely the name: a call whose result is discarded composes
    // nothing, and the claim here is that the leaf's statements really join the
    // bootstrap's query list.
    expect(
      read(STORE),
      "the store no longer SPREADS the moment triple's DDL into the bootstrap",
    ).toContain("...agentRunLifecycleMomentSchemaQueries(");
  });

  it("no module outside the ONE classifier compares a run's moment to a moment literal", () => {
    // THE CLAIM. `classifyRunWaitInterrupt` reads the recorded moment; a screen
    // asks IT rather than asking the row itself. A second module comparing
    // `lifecycleMoment` to a moment IS a screen re-deriving one, whatever it
    // calls itself, and it is how the two answers drift apart again.
    //
    // The coordinator is deliberately not on this list: it WRITES the moment and
    // its own reads are null checks, not moment literals. If it ever compares to
    // one, that is a finding this arm should report.
    //
    // RESIDUALS, NAMED. Both operand orders and both quote styles are modelled;
    // a `switch` is modelled at its DISCRIMINANT — `switch (…lifecycleMoment…)`.
    // NOT modelled: a `case` over a local the moment was bound to earlier, a
    // comparison against a CONSTANT that holds a moment, a moment reached
    // through destructuring under a different local name, and a template
    // literal. Each of those costs a missed violation, never a false green about
    // a spelling this arm did check.
    const moments = LIFECYCLE_MOMENTS.map((m) => m).join("|");
    const literal = `["'](?:${moments})["']`;
    const comparison = new RegExp(
      [
        `lifecycleMoment\\s*(?:===|!==|==|!=)\\s*${literal}`,
        `${literal}\\s*(?:===|!==|==|!=)\\s*[\\w.?[\\]]*lifecycleMoment`,
        `switch\\s*\\([^)]*lifecycleMoment`,
      ].join("|"),
    );
    expect(sourcesMatching(comparison)).toEqual([CLASSIFIER]);
  });

  it("the retired predicate and the three inline prefix tests live only in it", () => {
    // The two stand-ins the plan retired: the synthetic `setup-` task identity
    // and the presence of a field name. They stay BENEATH the reader (a run
    // created before the column existed carries no moment), so they are not
    // deleted; what may not happen is a surface reaching for them directly.
    //
    // THE THREE INLINE PREFIX TESTS are scanned beside the exported names,
    // because re-spelling the test inline is the cheapest way to re-derive the
    // wait while every exported identifier stays untouched: `startsWith`, a
    // `/^setup-/` regular expression, and `indexOf`.
    //
    // `index.ts` is the package barrel (a re-export, not a decision), and
    // `hitl-gate-submit.ts` asks a DIFFERENT question with the same predicate —
    // "is this gate the setup gate", which decides where a submit is POSTED, not
    // what the run is waiting at.
    //
    // RESIDUALS, NAMED, and they are the reason this arm's title says "the
    // predicate and the three inline prefix tests" rather than "the heuristics":
    //   · a FOURTH way of testing the prefix — a template literal, a `slice`
    //     compare, equality against a locally-built constant — is not scanned.
    //     The bare literal `"setup-"` cannot be scanned instead: 22 unrelated
    //     product files spell it (`setup-flash`, `setup-step-state`, the setup
    //     wizard's own routes), so an allowlist over it would be noise a reader
    //     stops reading;
    //   · the OTHER retired heuristic — classifying by the mere presence of
    //     `fieldName` — has no distinctive spelling at all (`fieldName` is an
    //     ordinary field on every gate shape), so it is NOT covered here.
    // `run-surface-status.test.ts` covers the classifier's own precedence
    // behaviourally; a surface re-deriving by either residual is a review
    // question this arm does not answer.
    const allowed = [
      "packages/agents/src/hitl-gate-submit.ts",
      "packages/agents/src/index.ts",
      CLASSIFIER,
    ];
    expect(
      sourcesMatching(/isSetupInterruptTaskId|SETUP_GATE_TASK_ID_PREFIX/),
    ).toEqual(allowed);
    // The two server actions below spell the prefix as a LITERAL rather than
    // importing the constant. They are allowed here — and named rather than
    // pattern-matched away — because they ask `hitl-gate-submit.ts`'s question,
    // not this clause's: a submit and a reject route by the gate's identity,
    // which decides WHERE the write goes, and neither reads or reports what the
    // run is waiting at. That they duplicate the prefix instead of importing
    // `SETUP_GATE_TASK_ID_PREFIX` is a hygiene finding recorded on cinatra#2936,
    // not a screen re-deriving a moment; a THIRD module spelling any of the
    // three scanned prefix tests reds this arm.
    expect(
      sourcesMatching(
        /startsWith\(\s*["'`]setup-["'`]\s*\)|\/\^setup-|indexOf\(\s*["'`]setup-["'`]\s*\)/,
      ),
      "a module spells the retired `setup-` prefix test inline",
    ).toEqual([
      "packages/agents/src/actions.ts",
      "packages/agents/src/review-task-actions.ts",
    ]);
  });
});

// ---------------------------------------------------------------------------
// B. ONE ROAD — "A conversation whose model cannot use tools says so when asked
//    to act; the buttons still work; no silent no-op."
// ---------------------------------------------------------------------------

describe("§6 One road — the tool-capability primitives are confined to the model seam", () => {
  it("the three canonical conversation-only primitives are named on the model seam alone", () => {
    // WHAT THIS PROVES, EXACTLY, AND WHAT IT DOES NOT.
    //
    // PROVES: the three CANONICAL conversation-only primitives — the provider
    // list, the predicate over it and the notice built from it — are named
    // nowhere but the model seam, so no card path is gated on THEM. That is the
    // structural half of "the buttons still work": a card whose controls could
    // consult the shipped capability answer is one edit away from a button that
    // silently does nothing.
    //
    // DOES NOT PROVE: that no card path reaches a provider capability by some
    // OTHER route — reading a provider name directly, or a differently named
    // helper — and does not prove that a button is present, wired and effective
    // on a real screen while the conversation runs tool-less. The latter is an
    // observation about a rendered surface and belongs to a Playwright project
    // of this harness's own config; #2936 part 2 owes it.
    //
    // The clause's other two halves are already covered and are not restated:
    // "says so when asked to act" and "no silent no-op" are
    // `src/lib/assistant-runtime/__tests__/model-routing.test.ts`, which asserts
    // the notice names the refusal and forbids pretending the action happened.
    //
    // The defining module and the turn composer that appends the notice are the
    // whole legitimate set.
    const readers = sourcesMatching(
      /isConversationOnlyProvider|PROVIDERS_WITHOUT_NATIVE_MCP|conversationOnlyNoticeFor/,
    );
    expect(readers).toEqual([
      "src/lib/assistant-runtime/model-routing.ts",
      "src/lib/assistant-runtime/runtime.ts",
    ]);
  });
});

// ---------------------------------------------------------------------------
// C. THE RUNNER — "the schedule moment is shown for every run a person starts …
//    with run-now selected unless a schedule was stated in the conversation, and
//    never for a run nobody is present for."
// ---------------------------------------------------------------------------

describe("§6 The runner — the schedule moment for a run a person starts", () => {
  it("the decision is stated ONCE, and the surfaces that draw a schedule read it", () => {
    // THE GAP THIS ARM RECORDED IS CLOSED (cinatra#2936). It was written to red
    // the moment a consumer appeared, and it did. What it asserts now is the
    // other side of the same fact, and it is still live in both directions: a
    // second statement of the decision reds it, and so does a surface that stops
    // reading it.
    //
    // The scans are on the BARE IDENTIFIERS, not on a call shape, so an aliased
    // import or a callback reference counts too.
    //
    // ONE STATEMENT, and this is the arm that says so: the decision is DECLARED
    // in exactly one module. It is the tier-neutral card registry rather than
    // the coordinator's own file because the coordinator is `server-only` and
    // both surfaces that draw a schedule are client modules; the coordinator,
    // which owns the decision, exports it from there under its own name. A
    // second declaration anywhere reds this.
    expect(sourcesMatching(/export function scheduleDefaultForLaunch/)).toEqual([
      REGISTRY,
    ]);

    // AND THESE ARE THE ONLY FILES THAT SO MUCH AS NAME IT — the statement, the
    // owner that exports it, and the two surfaces whose own notes say which
    // decision they are applying. A fifth file naming it reds this arm, which is
    // what keeps a second copy from appearing quietly.
    expect(sourcesMatching(/scheduleDefaultForLaunch/)).toEqual([
      REGISTRY,
      COORDINATOR,
      SCHEDULING_STEP,
      HELD_SCHEDULE_CARD,
    ]);

    // ONE MAPPING, AND ITS CONSUMERS. `scheduleScreenSelection` turns the
    // decision's answer into the row a screen opens on. Its readers are the run
    // page's own scheduling step and the held schedule's card body — the two
    // surfaces §3 names — and nobody else names it at all.
    expect(sourcesMatching(/scheduleScreenSelection/)).toEqual([
      REGISTRY,
      COORDINATOR,
      SCHEDULING_STEP,
      HELD_SCHEDULE_CARD,
    ]);

    // AND THEY READ IT, rather than merely naming it. A comment outlives an
    // import, so the set above cannot tell a consumer from a file that only
    // mentions the decision it used to apply: each surface is pinned to the
    // import EDGE and to a call, IN ITS CODE — comments stripped first, or a
    // commented-out pair would answer for a retired edge.
    for (const surface of [SCHEDULING_STEP, HELD_SCHEDULE_CARD]) {
      const text = withoutComments(read(surface));
      expect(text, `${surface} no longer imports the mapping`).toMatch(
        /import \{ scheduleScreenSelection \} from "@cinatra-ai\/agent-ui-protocol\/renderable-views";/,
      );
      expect(text, `${surface} no longer calls the mapping`).toMatch(
        /scheduleScreenSelection\([^\S\n]*\{/,
      );
    }

    // AND THE STEP STATES NO DEFAULT OF ITS OWN — the duplicate this closed.
    expect(
      read(SCHEDULING_STEP),
      "the scheduling step names the row itself again",
    ).not.toMatch(/defaultValues:\s*\{\s*triggerType/);

    // The record is the decision's OWN doc comment on each side, comment-markers
    // stripped and whitespace normalized, so a re-wrap is not a failure and a
    // failure prints a sentence rather than a sixty-kilobyte module.
    const docBefore = (relative: string, declaration: RegExp) => {
      const text = read(relative);
      const at = text.search(declaration);
      return text
        .slice(text.lastIndexOf("/**", at), at)
        .replace(/\n\s*\*\s?/g, " ")
        .replace(/\s+/g, " ");
    };
    // The statement still says what the decision IS.
    const statement = docBefore(REGISTRY, /export function scheduleDefaultForLaunch/);
    expect(statement).toMatch(/never for a run nobody is present for/i);

    // AND THAT IT ARMS NOTHING — the guard the recorded-gap arm carried, kept
    // against the relocated statement. The decision answers what a SCREEN
    // offers; the entry that creates runs does not apply it, and a call added
    // there would disturb neither file set above.
    expect(statement).toContain("`launchAgentRun` does not call it");
    expect(
      read(COORDINATOR),
      "the launch entry applies the schedule default",
    ).not.toMatch(/scheduleDefaultForLaunch\s*\(/);
    // The coordinator still says the decision is its own, and why the statement
    // sits where it does.
    const owner = docBefore(COORDINATOR, /export \{\s*\n\s*scheduleDefaultForLaunch,/);
    expect(owner).toContain("cinatra#2936");
    expect(owner).toContain("tier-neutral card registry");
  });

  it.skip(
    "OWED — the schedule moment is SHOWN for every run a person starts, from the run page with or without setup fields, from a conversation and from a third-party application (the selection it opens with is met: cinatra#2936)",
    () => {
      // Deliberately unimplemented rather than written-and-red, and NARROWER
      // than it was. The clause's selection half — "with run-now selected unless
      // a schedule was stated" — is met and covered behaviourally by
      // `packages/agents/src/__tests__/schedule-default-one-consumer-2936.test.tsx`
      // (the step opens on the row the decision names, a stated schedule is
      // filled into the rows, and a run nobody is present for gets no selection)
      // and by `src/lib/lifecycle/__tests__/schedule-card-rows-from-the-decision-2936.test.ts`
      // for the held schedule's card.
      //
      // What is left is an observation about three RENDERED hosts, which belongs
      // to a Playwright project of this harness's own config — the same place
      // the tool-less-conversation clause above leaves its rendered half. The
      // live arm above holds the decision honest meanwhile.
    },
  );
});

// ---------------------------------------------------------------------------
// D. THE FIXTURES THEMSELVES — "run … inside the held-turn harness S9k builds …
//    rather than a second harness" (cinatra#2936).
// ---------------------------------------------------------------------------

const WORKFLOWS_DIR = path.join(REPO_ROOT, ".github", "workflows");

/**
 * THIS PLAN'S OWN private proof tiers — a root `vitest.integration-*.config.ts`
 * per wave — and the package script each is reached through.
 *
 * SCOPED TO THIS PLAN ON PURPOSE. Other slices' tiers are in the same condition;
 * pinning them here would make an unrelated slice's new tier red a lifecycle
 * fixture, which is a maintenance tax with no reader.
 */
const PLAN_PROOF_TIERS: ReadonlyArray<{
  readonly script: string;
  readonly config: string;
  readonly wave: string;
}> = [
  { script: "test:lifecycle-moment", config: "vitest.integration-2928.config.ts", wave: "W2a" },
  { script: "test:lent-action-grant", config: "vitest.integration-2932.config.ts", wave: "W5a" },
  { script: "test:run-window", config: "vitest.integration-2933.config.ts", wave: "W5b" },
  { script: "test:named-agent-start", config: "vitest.integration-2935.config.ts", wave: "W5d" },
];

/** Every package script, by name. */
function packageScripts(): Readonly<Record<string, string>> {
  const pkg = JSON.parse(read("package.json")) as {
    scripts?: Record<string, string>;
  };
  return pkg.scripts ?? {};
}

/** `pnpm x` / `pnpm run x` / `npm run x`, ending at a real word boundary. */
function invocationOf(script: string): RegExp {
  return new RegExp(
    `(?:pnpm|npm|yarn) (?:run )?${escapeForRegExp(script)}(?![\\w:.-])`,
  );
}

const WORKFLOW_TEXT = readdirSync(WORKFLOWS_DIR)
  .filter((f) => /\.ya?ml$/.test(f))
  .map((f) => readFileSync(path.join(WORKFLOWS_DIR, f), "utf8"))
  .join("\n");

/**
 * Is this tier reached by a workflow — DIRECTLY, or through another package
 * script that reaches it?
 *
 * TRANSITIVE, because an aggregate script (`test:all` and its kind) is a real
 * wiring a workflow-text-only scan would miss, and missing one would let this
 * arm claim a tier is un-run when it is not. The closure walks UPWARD from the
 * tier: every script whose command EXPLICITLY invokes something already in the
 * set joins it, until it stops growing. npm's implicit lifecycle edges (`pre*`,
 * `post*`) are NOT modelled — a tier reached only through one of those would
 * read as un-run, which is the missed-gap direction, never a false claim.
 */
function invokedByAWorkflow(
  script: string,
  config: string,
  text: string = WORKFLOW_TEXT,
): boolean {
  const scripts = packageScripts();
  const reaching = new Set<string>([script]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const [name, command] of Object.entries(scripts)) {
      if (reaching.has(name)) continue;
      const hits = [...reaching].some((s) => invocationOf(s).test(command));
      if (hits || command.includes(config)) {
        reaching.add(name);
        grew = true;
      }
    }
  }
  if (text.includes(config)) return true;
  return [...reaching].some((s) => invocationOf(s).test(text));
}

/** The job key of the held-turn harness's CI job, and the file it lives in. */
const HARNESS_WORKFLOW = "build-image.yml";
const HARNESS_JOB = "chat-hitl-held-turn-e2e";

/**
 * The text of ONE job in the harness's workflow — from its key to the next
 * top-level job key. Read by INDENTATION rather than by a YAML parse because
 * that is all this needs and the same file is read as text three lines above;
 * a job that is absent yields "", which the arm asserts against rather than
 * passing vacuously.
 */
function harnessJobText(): string {
  const lines = readFileSync(
    path.join(WORKFLOWS_DIR, HARNESS_WORKFLOW),
    "utf8",
  ).split("\n");
  const start = lines.indexOf(`  ${HARNESS_JOB}:`);
  if (start === -1) return "";
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^  [A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join("\n");
}

/** The jobs the `build` fan-in requires, read off its own `needs:` line. */
function buildPrerequisites(): readonly string[] {
  const text = readFileSync(path.join(WORKFLOWS_DIR, HARNESS_WORKFLOW), "utf8");
  const match = /\n  build:\n(?:[^\n]*\n)*?    needs: \[([^\]]*)\]/.exec(text);
  return match ? match[1].split(",").map((s) => s.trim()) : [];
}

describe("§6 — the plan's fixtures run in CI", () => {
  it("this plan's four private proof tiers are invoked by a workflow", () => {
    // WAS THE RECORD, IS NOW THE GUARANTEE. A fixture wired to a config nothing
    // runs is the vacuity class this repo already refuses elsewhere
    // (`scripts/audit/ci-pinned-tests-exist.mjs`), and it arrived through a door
    // that guard did not watch: a ROOT config named in a package script rather
    // than a file path pinned inside a workflow step. All four tiers are now
    // steps of this harness's own CI job, and direction 4 of that same guard
    // fails on the next root tier that arrives unwired anywhere. The W5b tier
    // is what that guard then held: it landed after the first three were wired,
    // spent the interval as a ledger row, and joined them as the job's fourth
    // tier step — which is why this table is read from `PLAN_PROOF_TIERS` and
    // not from a sentence saying how many there are.
    //
    // THIS ARM IS NOT THAT GUARD, and does not duplicate it. The guard governs
    // EVERY root tier and decides enforceability from the workflow's structure;
    // this arm says one narrower thing the plan cares about — that THESE FOUR,
    // the proof of this plan's own waves, are among the wired ones — and it says
    // it from the harness, where §6's own conformance sentence is checked.
    //
    // RESIDUAL, NAMED. The reach here is workflow TEXT: a mention inside a
    // comment, an echoed command, a `continue-on-error` step or a job that never
    // fires would all read as invoked. That direction costs a missed gap, never
    // a false claim that a tier IS un-run. The structural reading is the guard's
    // job, and it runs in the same required workflow.
    const script = (t: (typeof PLAN_PROOF_TIERS)[number]) => t.script;

    // INSIDE THIS HARNESS'S JOB, which is the clause's own words — not merely
    // "some workflow somewhere". The job text is read on its own so a tier
    // wired into a job of its own would still red this arm, and the job is
    // asserted to exist first so an empty read cannot pass vacuously.
    const jobText = harnessJobText();
    expect(jobText, `${HARNESS_JOB} is not a job in ${HARNESS_WORKFLOW}`).not.toEqual("");
    const outside = PLAN_PROOF_TIERS.filter(
      (t) => !invokedByAWorkflow(t.script, t.config, jobText),
    ).map(script);
    expect(outside).toEqual([]);

    // …and that job is REQUIRED, which is the other half of the clause: it is a
    // prerequisite of the `build` fan-in, the context branch protection names.
    expect(buildPrerequisites()).toContain(HARNESS_JOB);

    // Each named tier really is a root integration config reached through that
    // script, and that config really is a file — otherwise the arm above is
    // four string comparisons against nothing, and it would keep passing after
    // a rename on either side.
    const scripts = packageScripts();
    for (const tier of PLAN_PROOF_TIERS) {
      const command = scripts[tier.script];
      expect(command, `${tier.wave}: ${tier.script} is not a package script`).toBeTypeOf(
        "string",
      );
      expect(command, `${tier.wave}: ${tier.script}`).toMatch(
        new RegExp(`--config ${escapeForRegExp(tier.config)}(?![\\w.-])`),
      );
      expect(
        statSync(path.join(REPO_ROOT, tier.config)).isFile(),
        `${tier.wave}: ${tier.config} is not a file`,
      ).toBe(true);
    }

    // NEGATIVE CONTROL. The tier that was already wired before this plan is
    // credited by the whole-workflow read — so the detector is reading workflows
    // and not agreeing with itself — and is NOT credited by the harness job's
    // own text, which is what makes the arm above a claim about THIS job rather
    // than about the file. A script no workflow names is credited by neither, so
    // a green cannot mean "this detector credits everything"; that half is
    // spelled with a name no slice owns rather than with another slice's real
    // tier, because a control must not red when an unrelated slice wires its own
    // work.
    expect(
      invokedByAWorkflow(
        "test:async-notification-seam",
        "vitest.integration-2882.config.ts",
      ),
    ).toBe(true);
    expect(
      invokedByAWorkflow(
        "test:async-notification-seam",
        "vitest.integration-2882.config.ts",
        harnessJobText(),
      ),
    ).toBe(false);
    expect(
      invokedByAWorkflow(
        "test:no-such-tier-x2936",
        "vitest.integration-no-such-tier-x2936.config.ts",
      ),
    ).toBe(false);
  });
});
