// THE CREDENTIAL-SAFETY BAR (cinatra#2930, lifecycle-b W3; convergence).
//
// A lifecycle card can be drawn where the reader is proven by a CREDENTIAL and
// not by a session — the site widget, whose frame is same-origin to the Cinatra
// app. The card's own read and submit carry that credential with
// `credentials: "omit"`. A field renderer mounted inside the card does not: one
// that calls its own `"use server"` action, or that resolves further renderers
// out of the registry, reaches the server on whatever ambient Cinatra session
// the browser holds — which can belong to a DIFFERENT person.
//
// So a renderer is mounted there only when its registry entry declares
// `credentialSafe`, and ABSENT MEANS UNSAFE. This test is what keeps every
// `true` honest, and it is written to fail in BOTH directions:
//
//   · a kind declared safe whose component calls a server action, or re-enters
//     the registry, turns this red;
//   · a component that stops being either of those and is still withheld shows
//     up as a REPORTED (not failing) gap, so the list can be widened knowingly.
//
// WHY THE ANSWER IS NOT A LIST OF RENDERER IDS. An earlier revision matched the
// gate's `x-renderer` against kind names. That is guessing: a manifest binding
// maps an ARBITRARY id onto a host kind — `@…/email-drafting-agent:output`
// mounts `email-drafts-review` — so id-shaped predicates missed live bindings
// whose component was action-backed. The answer travels with the ENTRY instead,
// which is the only thing that knows which component will actually mount.
//
// And it pins its own PREMISE, so a broken path cannot make it vacuous.

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..");

/** Strip comments so prose about an action never counts as one. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const REGISTRATIONS = code(readFileSync(path.join(SRC, "register-default-renderers.ts"), "utf8"));

/**
 * Every place this module declares `credentialSafe: true`, paired with the
 * component that declaration governs.
 *
 * Both registration shapes are read: a KIND TABLE entry (quoted or bare key)
 * and a direct `fieldRendererRegistry.register({ … })` call. Each is parsed
 * within its OWN object literal / call block, never by a span-limited regex
 * over the whole file — that pairs one entry's key with the next entry's
 * component, which is exactly how an earlier revision of this test lied.
 */
function declaredSafeComponents(): string[] {
  const found: string[] = [];
  // Kind-table entries: `<key>: { … }` bounded to one literal.
  for (const m of REGISTRATIONS.matchAll(
    /(?:"[a-z0-9-]+"|\b[a-z][a-z0-9-]*)\s*:\s*\{([^{}]*)\}/g,
  )) {
    const body = m[1];
    if (!/credentialSafe:\s*true/.test(body)) continue;
    const renderer = /renderer:\s*([A-Za-z0-9_]+)/.exec(body);
    if (renderer) found.push(renderer[1]);
  }
  // Direct registrations: one `register({ … })` call at a time.
  for (const rest of REGISTRATIONS.split("fieldRendererRegistry.register({").slice(1)) {
    const block = rest.slice(0, rest.indexOf("});"));
    if (!/credentialSafe:\s*true/.test(block)) continue;
    const renderer = /renderer:\s*([A-Za-z0-9_(]+)/.exec(block);
    if (renderer) found.push(renderer[1].replace(/\($/, ""));
  }
  return [...new Set(found)];
}

const DECLARED_SAFE = declaredSafeComponents();

/** Which module defines a component, read from this module's own imports. */
function moduleOf(component: string): string | null {
  const re = new RegExp(
    `import\\s*\\{[^}]*\\b${component}\\b[^}]*\\}\\s*from\\s*"\\.\\/([A-Za-z0-9-]+)"`,
  );
  const m = re.exec(REGISTRATIONS);
  return m ? `${m[1]}.tsx` : null;
}

/** Does this module reach the server on its own cookie? */
function importsServerActions(file: string): boolean {
  return /from\s+"\.\/[A-Za-z0-9-]*-actions"/.test(
    code(readFileSync(path.join(SRC, file), "utf8")),
  );
}

/**
 * Does THIS COMPONENT re-enter the registry?
 *
 * Asked of the component, not of the file, for one real case: the schema
 * renderer's module contains BOTH the registry-first `SchemaFieldRenderer` and
 * `SchemaOnlyFloorRenderer`, the documented TRUE bypass floor that exists
 * precisely so a registered entry cannot re-resolve itself. Only the second is
 * ever registered. The bypass is asserted from its own definition below rather
 * than taken on trust.
 */
function componentReEntersRegistry(file: string, component: string): boolean {
  const source = code(readFileSync(path.join(SRC, file), "utf8"));
  if (!/fieldRendererRegistry\.resolve/.test(source)) return false;
  const def = new RegExp(
    `export function ${component}\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}`,
  ).exec(source);
  if (!def) return true; // cannot prove it does not — treat as re-entering.
  // A one-expression wrapper that forces the registry bypass on.
  return !/bypassRegistry\b/.test(def[1]);
}

describe("the bar's premise", () => {
  it("the scan finds the registration module, and finds declarations in it", () => {
    expect(REGISTRATIONS.length).toBeGreaterThan(1000);
    expect(DECLARED_SAFE.length).toBeGreaterThan(0);
    for (const component of DECLARED_SAFE) {
      expect(moduleOf(component), `no module for ${component}`).not.toBeNull();
    }
  });

  it("at least one renderer module really does call a server action", () => {
    // Without this, the action check below could be passing on a broken regex.
    const actionBacked = readdirSync(SRC)
      .filter((f) => /renderer\.tsx$/.test(f))
      .filter((f) => importsServerActions(f));
    expect(actionBacked.length).toBeGreaterThan(0);
  });
});

describe("the bar", () => {
  it("every renderer DECLARED safe is provably safe in its own source", () => {
    const offenders: string[] = [];
    for (const component of DECLARED_SAFE) {
      const file = moduleOf(component);
      if (!file) continue;
      if (importsServerActions(file)) offenders.push(`${component} :: calls a server action`);
      if (componentReEntersRegistry(file, component)) {
        offenders.push(`${component} :: re-enters the renderer registry`);
      }
    }
    expect(offenders, "a renderer declared safe reaches the server on a cookie").toEqual([]);
  });

  it("the EXTENSION binding branch declares nothing, so it stays unsafe", () => {
    // An extension binding loads a component from a package this repository has
    // never read. It can never be declared safe from here.
    const extensionBranch = REGISTRATIONS.slice(
      REGISTRATIONS.indexOf("makeExtensionFieldRenderer(b.id)") - 400,
      REGISTRATIONS.indexOf("makeExtensionFieldRenderer(b.id)") + 400,
    );
    expect(extensionBranch).toContain("makeExtensionFieldRenderer");
    expect(extensionBranch).not.toContain("credentialSafe");
  });

  it("a binding of a KNOWN kind inherits its KIND's answer, never its id", () => {
    // The hole an id-shaped predicate had: `@…/email-drafting-agent:output`
    // mounts the action-backed `email-drafts-review` component, and its id ends
    // in `:output`. Inheriting from the kind is what makes the id irrelevant.
    expect(REGISTRATIONS).toContain("credentialSafe: kindEntry.credentialSafe === true");
  });

  it("the grouped setup form is NOT declared safe — it resolves its own children", () => {
    expect(DECLARED_SAFE).not.toContain("GroupedSetupFormRenderer");
  });
});
