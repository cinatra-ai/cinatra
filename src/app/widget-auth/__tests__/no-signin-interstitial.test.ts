// cinatra#2631 — THE HOSTED WIDGET LOGIN HAS NO SECOND STEP.
//
// Owner ruling (2026-08-10): "treat sign in as consent." The consent
// interstitial cinatra#407 shipped — a card headed "Continue to the assistant"
// with a Continue button a signed-in member had to press — is removed. Nothing
// now stands between arriving at this page and the code going back to the site:
// where a sign-in is needed the sign-in authorizes, and where a Cinatra session
// already exists that session does.
//
// A removal is only as durable as the thing that notices it coming back, and
// this one would come back plausibly: the natural way to add a SECOND grant
// later is to add a screen that asks about it. So this bar is drawn around the
// whole hosted widget-auth surface and, like the AC-3 bar it is modelled on, it
// fails in both directions:
//
//   • the bar — no production module in the surface may render a step between
//     the sign-in and the return, nor consume the consent-CSRF the step needed;
//   • the bar's PREMISE — the surface must still contain the sign-in screen, the
//     return component and the one server action, so deleting the flow cannot
//     quietly turn this suite into a test that asserts nothing.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../../../..");

/** Every production module of the hosted widget-auth surface. */
const SURFACE_ROOTS = ["src/app/widget-auth", "src/components/widget-auth"];

function walk(dir: string): string[] {
  const abs = path.join(REPO_ROOT, dir);
  const out: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) {
        if (entry === "__tests__") continue; // the bar governs production code
        visit(full);
        continue;
      }
      if (/\.tsx?$/.test(entry)) out.push(full);
    }
  };
  visit(abs);
  return out;
}

/** Strip comments so prose ABOUT the removed screen never trips the bar. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const SURFACE_FILES = SURFACE_ROOTS.flatMap(walk);
const sourceOf = (file: string) => code(readFileSync(file, "utf8"));
const rel = (file: string) => path.relative(REPO_ROOT, file);

describe("the bar's premise", () => {
  it("covers the whole hosted widget-auth surface", () => {
    // An empty file list would make every assertion below vacuously true.
    expect(SURFACE_FILES.length).toBeGreaterThanOrEqual(4);
  });

  it("the flow still exists: a sign-in screen, a return step and ONE action", () => {
    const names = SURFACE_FILES.map((f) => path.basename(f)).sort();
    expect(names).toContain("widget-auth-login.tsx");
    expect(names).toContain("widget-auth-grant.tsx");
    expect(names).toContain("widget-auth-success.tsx");
    expect(names).toContain("actions.ts");
    expect(names).toContain("page.tsx");
  });

  it("and those files are REACHED, not merely present", () => {
    // A filename check alone could be satisfied by orphans while the real flow
    // moved somewhere this bar does not cover (codex rework round 0, finding 4).
    // Pin the import edges the flow actually runs through.
    const page = sourceOf(path.join(REPO_ROOT, "src/app/widget-auth/page.tsx"));
    expect(page).toContain("widget-auth/widget-auth-login");
    expect(page).toContain("widget-auth/widget-auth-grant");
    expect(page).toContain("<WidgetAuthLogin");
    expect(page).toContain("<WidgetAuthGrant");

    const grant = sourceOf(
      path.join(REPO_ROOT, "src/components/widget-auth/widget-auth-grant.tsx"),
    );
    expect(grant).toContain("widget-auth/widget-auth-success");
    expect(grant).toContain("issueWidgetAuthCodeAction");
  });
});

describe("no step stands between the sign-in and the return", () => {
  it("the consent component is gone from the tree", () => {
    expect(
      existsSync(
        path.join(REPO_ROOT, "src/components/widget-auth/widget-auth-consent.tsx"),
      ),
    ).toBe(false);
  });

  it("nothing in the surface renders the interstitial's heading or its button", () => {
    const offenders = SURFACE_FILES.filter((file) => {
      const src = sourceOf(file);
      return (
        src.includes("Continue to the assistant") ||
        /WidgetAuthConsent/.test(src) ||
        /"Continuing…"|Continuing…/.test(src)
      );
    });
    expect(offenders.map(rel)).toEqual([]);
  });

  it("no production module asks the person to press ANYTHING", () => {
    // Not just the old button: any affordance. The grant is fired unattended, so
    // this whole surface renders no button, no click handler and no form — a
    // differently named "Authorize" step would trip this even though it shares no
    // wording with the screen that was removed (codex rework round 0, finding 4).
    // The sign-in form itself lives inside the shared AuthView component, which
    // is not part of this surface.
    const offenders = SURFACE_FILES.filter((file) => {
      const src = sourceOf(file);
      return (
        /<form\b/.test(src) ||
        /<button\b/i.test(src) ||
        /<Button\b/.test(src) ||
        /onClick\s*=/.test(src) ||
        /type="submit"/.test(src) ||
        /role="button"/.test(src) ||
        /useFormStatus|useActionState/.test(src)
      );
    });
    expect(offenders.map(rel)).toEqual([]);
  });

  it("the consent CSRF is gone — it guarded a screen that no longer exists", () => {
    // The displayed-scope binding (a single-use CSRF token signed over the scope
    // set the consent screen showed) protected one thing: a submission
    // authorizing a grant whose sentence was never displayed. With no submission
    // and no second screen there is nothing left for it to protect, so it is
    // removed rather than left as decoration that implies a guarantee.
    const offenders = SURFACE_FILES.filter((file) =>
      /ConsentCsrfToken|consent_csrf|widgetConsentRequestId/.test(sourceOf(file)),
    );
    expect(offenders.map(rel)).toEqual([]);
  });

  it("widgetConsentRequestId no longer exists anywhere in the product", () => {
    const scope = readFileSync(
      path.join(REPO_ROOT, "src/lib/widget-lifecycle-scope.ts"),
      "utf8",
    );
    expect(code(scope)).not.toContain("widgetConsentRequestId");
  });
});

describe("the sign-in itself carries the grant", () => {
  const pageSrc = sourceOf(path.join(REPO_ROOT, "src/app/widget-auth/page.tsx"));
  const actionSrc = sourceOf(path.join(REPO_ROOT, "src/app/widget-auth/actions.ts"));

  it("the sign-in screen names every scope the sign-in grants", () => {
    // Generated from the vocabulary, not hand-written: a grant added to the set
    // gains its sentence on this screen at the same moment.
    expect(pageSrc).toContain("WIDGET_SIGNIN_GRANTED_SCOPES.map");
    expect(pageSrc).toContain("WIDGET_EXTENSION_SCOPES[scope].consentCopy");
    // ...and it is rendered on the SIGNED-OUT branch, which is the screen a
    // person actually reads before they hand over credentials.
    const signedOut = pageSrc.slice(pageSrc.indexOf("if (!session)"));
    expect(signedOut).toContain("<SignInGrantNotice");
  });

  it("the member branch goes straight to the return step", () => {
    const memberBranch = pageSrc.slice(pageSrc.lastIndexOf("resolveOrgRoleForUser"));
    expect(memberBranch).toContain("<WidgetAuthGrant");
    expect(memberBranch).not.toContain("Continue");
  });

  it("the recorded grant comes from the server constant and nothing else", () => {
    expect(actionSrc).toContain("grantedScopes: WIDGET_SIGNIN_GRANTED_SCOPES");
    // No request-borne channel: no FormData and no body parsing. The displayed
    // set the action DOES receive is compared, never recorded — it appears only
    // in the agreement check.
    expect(actionSrc).not.toMatch(/FormData|formData/);
    expect(actionSrc).not.toMatch(/grantedScopes:\s*displayedScopes/);
  });

  it("the SERVER records what the sign-in screen displayed, and the action reads it there", () => {
    // The comparison is only trustworthy if the record cannot be removed by
    // whoever controls the popup's URL (codex rework round 1, finding 1). The
    // sign-in branch writes it onto the transaction; the action reads it off the
    // transaction and nowhere else.
    const signedOut = pageSrc.slice(
      pageSrc.indexOf("if (!session)"),
      pageSrc.indexOf("const userId"),
    );
    expect(signedOut).toContain("recordDisplayedScopesForTransaction");
    expect(signedOut).toContain("widgetDisplayedScopesToken(WIDGET_SIGNIN_GRANTED_SCOPES)");
    expect(actionSrc).toContain(
      "displayedScopesAgree(txn.displayedScopes, WIDGET_SIGNIN_GRANTED_SCOPES)",
    );
    // ...and NOT off the request: the action takes the transaction id alone.
    expect(actionSrc).toMatch(/issueWidgetAuthCodeAction\(\s*txnId: string,\s*\)/);
    expect(pageSrc).not.toContain("&s=");
  });
});
