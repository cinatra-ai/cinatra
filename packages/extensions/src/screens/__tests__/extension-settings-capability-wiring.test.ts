// cinatra#2416 — structural pins for the SERVER-DERIVED lifecycle capability.
//
// Node-env source assertions, mirroring extension-settings-view.test.ts: these
// pin the WIRING invariants that no behavioural unit test can express, because
// the defect they guard against is "someone re-implemented the rule somewhere
// else" rather than "a function returned the wrong value".
//
// The load-bearing invariants:
//   1. the settings loader derives the affordances from the ENFORCING module,
//      against an actor built by the SAME builder the form actions use;
//   2. no client module implements the addressing rule (org-equality) itself;
//   3. the presentational view never sees a row id, an org id or the actor —
//      only `allowed`-derived reason strings.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import * as path from "node:path";

const read = (rel: string): string => readFileSync(path.resolve(__dirname, rel), "utf8");

const SCREEN = read("../extension-settings-screen.tsx");
const VIEW = read("../extension-settings-view.tsx");
const MODEL = read("../extension-settings-model.ts");
const ACTIONS_UI = read("../extension-settings-actions.tsx");
const ACTIONS = read("../../actions.ts");
const RESOLVER = read("../../lifecycle-target-resolver.ts");
const ACTOR = read("../../lifecycle-actor.ts");

describe("AC1 — the enabled state comes from the ENFORCING module", () => {
  it("the loader asks the resolver (not a local copy) for the capability", () => {
    // The import is a named-list form (it grew a second name in cinatra#2762
    // round 5), so pin the SPECIFIER and the name, not the exact statement text.
    expect(SCREEN).toMatch(
      /import \{[^}]*\bdescribeLifecycleCapabilities\b[^}]*\} from "\.\.\/lifecycle-target-resolver"/,
    );
    expect(SCREEN).toContain("await describeLifecycleCapabilities(");
  });

  it("the capability is evaluated against the SAME actor builder the form actions use", () => {
    expect(SCREEN).toContain(
      'import { buildLifecycleActorFromSession } from "../lifecycle-actor"',
    );
    expect(SCREEN).toContain("await buildLifecycleActorFromSession(");
    // …and the form actions import it from that same module, not their own copy.
    expect(ACTIONS).toContain('} from "./lifecycle-actor"');
    expect(ACTIONS).toContain("await buildLifecycleActorFromSession(");
    // The builder no longer lives in the "use server" module (whose exports
    // would become callable Server Functions).
    expect(ACTIONS).not.toMatch(/(async )?function buildLifecycleActorFromSession\s*\(/);
    expect(ACTIONS).not.toMatch(/function buildActorEnvelope\s*\(/);
  });

  it("the actor builder is server-only and NOT a Server Function module", () => {
    expect(ACTOR).toContain('import "server-only"');
    // The `"use server"` DIRECTIVE (which would turn every export into a
    // callable RPC endpoint) must not open the file. Prose mentions of the
    // string in the header comment are fine.
    expect(ACTOR.trimStart().startsWith('"use server"')).toBe(false);
    expect(ACTOR).not.toMatch(/^\s*"use server";\s*$/m);
  });

  it("the affordance resolver REQUIRES the capability (no enabled-by-default escape)", () => {
    expect(MODEL).toMatch(/capabilities:\s*LifecycleCapabilityMap;/);
    expect(MODEL).not.toMatch(/capabilities\?:/);
  });

  it("the PACKAGE-WIDE lock is a separate, required input from the target row", () => {
    // `assertNoLockedCanonicalRow` is scope-blind; the affordance must be greyed
    // by a locked SIBLING, not only by a locked target row.
    expect(MODEL).toMatch(/lockedRow:\s*InstalledExtension \| null;/);
    expect(MODEL).toContain("lockedRow ? lifecycleInvariantReason(lockedRow, action) : null");
    expect(SCREEN).toContain("lockedRow: lifecycleLockedRow,");
    expect(RESOLVER).toContain('rows.find((r) => r.status === "locked") ?? null');
  });

  it("the enforcement and the capability share ONE addressing implementation", () => {
    // pickLifecycleTargetRow (what the dispatcher calls) is a wrapper over the
    // same resolveLifecycleScope the capability evaluates.
    expect(RESOLVER).toContain("export function resolveLifecycleScope(");
    expect(RESOLVER).toMatch(
      /export function pickLifecycleTargetRow\([\s\S]*?const resolution = resolveLifecycleScope\(rows, actor, selector\);/,
    );
    expect(RESOLVER).toMatch(
      /export function evaluateLifecycleCapability\([\s\S]*?resolveLifecycleScope\(rows, actor, selector\)/,
    );
    // The org-equality filter appears exactly ONCE in the whole module — now
    // inside `addressableLifecycleRows`, the single home of the addressable
    // set that both the resolution and the capability read (cinatra#2698).
    const filters = RESOLVER.match(/\(r\.organizationId \?\? null\) === actorOrgId/g) ?? [];
    expect(filters).toHaveLength(1);
    expect(RESOLVER).toMatch(
      /export function addressableLifecycleRows\([\s\S]*?export function resolveLifecycleScope\(/,
    );
  });
});

describe("AC1 — no client-side re-derivation of the addressing rule", () => {
  // Every "use client" module under packages/extensions + the presentational
  // settings view. None may compare a row's organizationId to an actor's org,
  // nor import the server-only resolver at runtime.
  const SCREENS_DIR = path.resolve(__dirname, "..");
  const clientSources: Array<[string, string]> = [];
  for (const entry of readdirSync(SCREENS_DIR)) {
    const full = path.join(SCREENS_DIR, entry);
    if (!statSync(full).isFile()) continue;
    if (!/\.tsx?$/.test(entry)) continue;
    const src = readFileSync(full, "utf8");
    if (src.startsWith('"use client"') || entry === "extension-settings-view.tsx") {
      clientSources.push([entry, src]);
    }
  }

  it("found the client surfaces to check (the scan is not vacuous)", () => {
    expect(clientSources.length).toBeGreaterThan(0);
    expect(clientSources.map(([n]) => n)).toContain("extension-settings-view.tsx");
    expect(clientSources.map(([n]) => n)).toContain("extension-settings-actions.tsx");
  });

  it.each([
    ["organizationId", /organizationId/],
    ["activeOrganizationId", /activeOrganizationId/],
    ["platformRole", /platformRole/],
    ["orgRole", /orgRole/],
    ["a value import of the server-only resolver", /from "\.\.\/lifecycle-target-resolver"/],
  ])("no client settings module mentions %s", (_label, pattern) => {
    for (const [name, src] of clientSources) {
      expect(src, `${name} must not reference it`).not.toMatch(pattern);
    }
  });

  it("the view takes only reason STRINGS — never a row, an actor or a capability object", () => {
    expect(VIEW).toContain("archiveDisabled: string | null;");
    expect(VIEW).toContain("forceDeleteDisabled: string | null;");
    expect(VIEW).toMatch(/lifecycleCapabilityReasons\?: Partial<[\s\S]*?Record<[\s\S]*?string>\s*>;/);
    expect(VIEW).not.toContain("InstalledExtension");
    expect(VIEW).not.toContain("Actor");
  });
});

describe("AC2 — the reason is rendered, in §V's disabled-with-reason language", () => {
  it("the disabled button keeps the established treatment (disabled + aria-disabled + reason)", () => {
    expect(ACTIONS_UI).toContain("disabled");
    expect(ACTIONS_UI).toContain('aria-disabled="true"');
    expect(ACTIONS_UI).toContain("title={reason}");
    // …plus the stable, non-visual assertion hooks.
    expect(ACTIONS_UI).toContain('data-slot="disabled-action"');
    expect(ACTIONS_UI).toContain("data-disabled-reason={reason}");
  });

  it("a SERVER capability denial also renders the reason as visible muted copy", () => {
    expect(VIEW).toContain('data-slot="lifecycle-capability-reason"');
    expect(VIEW).toContain("text-muted-foreground");
  });

  it("all FOUR lifecycle affordances route through the capability-aware disabled render", () => {
    for (const affordance of ["archive", "activate", "reinstall", "forceDelete"]) {
      expect(VIEW).toContain(`capabilityReason={lifecycleCapabilityReasons?.${affordance}}`);
    }
    // Every DisabledLifecycleAction call site is one of those four.
    const calls = VIEW.match(/<DisabledLifecycleAction/g) ?? [];
    expect(calls).toHaveLength(4);
  });
});

describe("AC3 — the enforcement is untouched and its refusals carry stable codes", () => {
  it("the dispatcher's gates are still the resolver's own, unchanged", () => {
    const INDEX = read("../../index.ts");
    // cinatra#2698 threads the operator's row selector as a third argument, so
    // the call is now multi-line — the GATE is the same one.
    expect(INDEX).toMatch(
      /await resolveLifecycleTargetRow\([\s\S]{0,120}ref\.packageName,[\s\S]{0,120}actor,/,
    );
    expect(INDEX).toContain("throw new PlatformAdminRequiredError(\"force_delete\")");
  });

  it("every refusal class carries its stable code", () => {
    for (const code of [
      "NO_ADDRESSABLE_ROW",
      "AMBIGUOUS_LIFECYCLE_TARGET",
      "NO_LIFECYCLE_WRITE_STANDING",
      "PLATFORM_ADMIN_REQUIRED",
    ]) {
      expect(RESOLVER).toContain(`= "${code}"`);
    }
  });

  it("a refused removal records the code operator-side", () => {
    expect(ACTIONS).toContain("reason=%s code=%s");
    // The code must be captured where the thrown error OBJECT still exists —
    // the caller only ever receives `error` flattened to a string, so reading
    // `.code` at the log site would silently always be "none".
    expect(ACTIONS).toContain("function stableErrorCode(");
    expect(ACTIONS).toContain("errorCode: stableErrorCode(err),");
    expect(ACTIONS).toContain("result.errorCode,");
  });
});

// ---------------------------------------------------------------------------
// cinatra#2762 round 5 — the recovery actions are BOUND to the row this page
// described, and the selector that binds them is minted SERVER-SIDE.
//
// Structural, because the defect is "the action re-resolves from the package
// name" — an omission no unit test of the action can see, since the action is
// correct for every row set where the two resolutions happen to agree.
// ---------------------------------------------------------------------------
describe("AC5 — the recovery pair acts on the row the page resolved", () => {
  it("the loader mints the selector from the RESOLVED row, not from a client hint", () => {
    expect(SCREEN).toMatch(
      /import \{[^}]*\blifecycleRowSelectorFor\b[^}]*\} from "\.\.\/lifecycle-target-resolver"/,
    );
    // From `resolution.row` — the row `describeLifecycleCapabilities` returned.
    expect(SCREEN).toMatch(
      /const lifecycleRowSelector\s*=\s*resolution\.ok\s*\?\s*lifecycleRowSelectorFor\(resolution\.row\)/,
    );
  });

  it("both recovery actions carry it", () => {
    expect(SCREEN).toMatch(
      /retryExtensionActivationFormAction\(\{[^}]*rowSelector:\s*lifecycleRowSelector/,
    );
    expect(SCREEN).toMatch(
      /rollBackExtensionToBundledFormAction\(\{[^}]*rowSelector:\s*lifecycleRowSelector/,
    );
  });

  it("both actions feed the VALIDATED selector to the ENFORCING resolver", () => {
    // Not a local re-implementation, and not the raw wire value: the selector
    // handed to `resolveLifecycleTargetRow` is the one
    // `validateLifecycleRowSelectorInput` returned, and that resolver
    // recomputes the addressable set from the ACTOR and only then filters it by
    // the named tier.
    const calls = [
      ...ACTIONS.matchAll(
        /resolveLifecycleTargetRow\(\s*input\.packageName,\s*actor,\s*selector\.selector,\s*\)/g,
      ),
    ];
    expect(calls.length).toBe(2);
    // The raw parameter never reaches the resolver.
    expect(ACTIONS).not.toMatch(/resolveLifecycleTargetRow\([^)]*input\.rowSelector/);
  });

  // -------------------------------------------------------------------------
  // THE REAL BOUNDARY (round-5 convergence).
  //
  // This block used to assert that no selector is read off `formData` — the
  // WRONG boundary. Both recovery actions are EXPORTED from a `"use server"`
  // module, so `rowSelector` is already a client-invokable RPC payload whether
  // or not any form carries it: a direct invocation supplies it straight. The
  // structural claim worth pinning is therefore not "the client cannot name a
  // row" (false) but "every path into these actions passes the enforcement
  // chain": admin session → shape validation → actor-bounded resolution.
  //
  // The BEHAVIOURAL half of this — a forged selector cannot reach a row outside
  // the actor's addressable set, and a malformed one is refused — is pinned in
  // `recovery-actions.test.ts`, which drives the exported actions directly with
  // the resolver unmocked. These are the structural companions: an omission a
  // behavioural test cannot see, because the action is correct for every input
  // that happens to be well-formed.
  // -------------------------------------------------------------------------
  it("both actions gate on an ADMIN SESSION first — the outermost bound", () => {
    // The selector can only ever narrow among the rows the ACTOR addresses, so
    // "who is the actor" has to be settled before anything else runs.
    for (const name of [
      "retryExtensionActivationFormAction",
      "rollBackExtensionToBundledFormAction",
    ]) {
      const body = ACTIONS.slice(ACTIONS.indexOf(`export async function ${name}`));
      const session = body.indexOf("await requireAdminSession()");
      expect(session).toBeGreaterThan(-1);
      expect(session).toBeLessThan(body.indexOf("validateLifecycleRowSelectorInput("));
      expect(session).toBeLessThan(body.indexOf("buildLifecycleActorFromSession("));
    }
  });

  it("both actions VALIDATE the selector before it reaches the resolver", () => {
    // A type annotation declares the shape of an RPC parameter; it does not
    // check it. Each action must call the validator and refuse on a bad shape.
    const calls = [...ACTIONS.matchAll(/validateLifecycleRowSelectorInput\(input\.rowSelector\)/g)];
    expect(calls.length).toBe(2);
    const refusals = [...ACTIONS.matchAll(/if \(!selector\.ok\) \{/g)];
    expect(refusals.length).toBe(2);
    // …and the validation precedes the resolution in both bodies.
    for (const name of [
      "retryExtensionActivationFormAction",
      "rollBackExtensionToBundledFormAction",
    ]) {
      const body = ACTIONS.slice(ACTIONS.indexOf(`export async function ${name}`));
      expect(body.indexOf("validateLifecycleRowSelectorInput(")).toBeLessThan(
        body.indexOf("resolveLifecycleTargetRow("),
      );
    }
  });

  it("the refusal is ATTRIBUTABLE, not a bare throw", () => {
    // A thrown error on a Next server action reaches the client masked, so a
    // bad payload would be indistinguishable from a server fault. Both actions
    // log the validator's reason and RETURN the classified failure.
    const calls = [
      ...ACTIONS.matchAll(
        /logMarketplaceFailureForOperator\(\s*"(?:retry-activation|roll-back-to-bundled)",\s*input\.packageName,\s*"unrecoverable",\s*selector\.reason,\s*\)/g,
      ),
    ];
    expect(calls.length).toBe(2);
  });

  it("the SCREEN still mints server-side — it is the only legitimate producer", () => {
    // Not a security boundary (see above), but it is what makes the ordinary
    // product path address the row the page described: the screen never builds
    // a selector from a client value, and never reads one off form data.
    expect(SCREEN).not.toMatch(/formData\.get\(\s*["'][^"']*[Ss]elector/);
    expect(SCREEN).not.toMatch(/ownerLevel:\s*(?!\w)/);
  });

  it("the view never sees the selector — it is not presentational data", () => {
    expect(VIEW).not.toContain("rowSelector");
    expect(VIEW).not.toContain("ownerLevel");
  });
});
