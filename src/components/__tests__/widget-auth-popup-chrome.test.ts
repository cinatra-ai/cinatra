// ---------------------------------------------------------------------------
// OWNER RULING 2026-08-13 — THE WIDGET SIGN-IN POPUP CARRIES NO APP CHROME.
//
// The widget's iframe opens `/widget-auth` as a 460×680 top-level window to
// complete the credential exchange (cinatra#2674). It was rendering inside the
// full app shell: sidebar, breadcrumb bar, theme switch, and the notifications
// bell — a link out of a login window, in a login window, for an app the person
// has not entered yet. The owner ruled the chrome off.
//
// TWO CONTEXTS, AND THE SECOND ONE IS THE POINT. A change that strips chrome
// from a sign-in surface is only safe if it CANNOT be aimed at the ordinary app
// sign-in, so this suite pins both directions:
//
//   • the popup route renders chromeless;
//   • `/sign-in` decides exactly as it did before this change — it was already
//     chromeless, and no URL a caller can build changes that or anything else.
//
// The decision is a pure function of the pathname, so these are unit tests over
// that function rather than a mount of the whole shell. What they would catch is
// exactly what can regress: an arm dropped, an arm widened into a prefix, or a
// request-borne value creeping into the decision.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  WIDGET_AUTH_POPUP_PATH,
  bypassesAppShellForPathname,
  isMcpHandshakePathname,
} from "@/components/app-shell";

const APP_SHELL_SRC = readFileSync(
  path.join(__dirname, "..", "app-shell.tsx"),
  "utf8",
);

describe("the widget sign-in popup renders without the app shell", () => {
  it("is the route the frame's authorize URL points at", () => {
    // `/api/widget-auth/frame/init` builds `${origin}/widget-auth?txn=…`, so the
    // constant this decision uses and the URL the popup actually opens are the
    // same string. A rename on one side without the other would leave the popup
    // chromed again, silently.
    expect(WIDGET_AUTH_POPUP_PATH).toBe("/widget-auth");
    const initRoute = readFileSync(
      path.join(__dirname, "../../app/api/widget-auth/frame/init/route.ts"),
      "utf8",
    );
    expect(initRoute).toContain(`${WIDGET_AUTH_POPUP_PATH}?txn=`);
  });

  it("bypasses the shell", () => {
    expect(bypassesAppShellForPathname(WIDGET_AUTH_POPUP_PATH)).toBe(true);
  });

  it("bypasses it for the URL the popup is actually opened at", () => {
    // The decision reads a pathname, never a search string: the popup arrives
    // carrying `?txn=…&n=…`, and those are not part of what is matched.
    expect(bypassesAppShellForPathname(new URL(
      `https://app.example.com${WIDGET_AUTH_POPUP_PATH}?txn=abc&n=def`,
    ).pathname)).toBe(true);
  });

  it("does NOT extend the bypass to anything merely nearby", () => {
    // An exact match, not a prefix — otherwise a future `/widget-auth-admin`
    // would inherit a chromeless render nobody asked for.
    expect(bypassesAppShellForPathname("/widget-auth/settings")).toBe(false);
    expect(bypassesAppShellForPathname("/widget-authority")).toBe(false);
    expect(bypassesAppShellForPathname("/widget-auth-admin")).toBe(false);
  });
});

describe("the normal app sign-in is unchanged", () => {
  it("still decides exactly as it did before the popup joined the list", () => {
    // `/sign-in` was already chromeless; this pins that the refactor which
    // extracted the decision did not move it.
    expect(bypassesAppShellForPathname("/sign-in")).toBe(true);
    expect(bypassesAppShellForPathname("/sign-up")).toBe(true);
    expect(bypassesAppShellForPathname("/permissions")).toBe(true);
    expect(bypassesAppShellForPathname("/permissions/settings")).toBe(true);
    expect(bypassesAppShellForPathname("/setup")).toBe(true);
    expect(bypassesAppShellForPathname("/setup/account")).toBe(true);
    expect(bypassesAppShellForPathname("/embed/assistant")).toBe(true);
    expect(bypassesAppShellForPathname("/lifecycle/review-island")).toBe(true);
    expect(isMcpHandshakePathname("/api/mcp/auth/authorize")).toBe(true);
    expect(isMcpHandshakePathname("/api/mcp/account/link")).toBe(true);
    expect(isMcpHandshakePathname("/api/mcp/consent")).toBe(true);
    expect(bypassesAppShellForPathname("/api/mcp/consent")).toBe(true);
  });

  it("and the ordinary app routes still get the shell", () => {
    // The premise: if everything bypassed, every assertion above would be
    // vacuous.
    for (const route of [
      "/",
      "/chat",
      "/chat/abc",
      "/notifications",
      "/configuration",
      "/lifecycle",
      "/embed",
      "/agents",
    ]) {
      expect(bypassesAppShellForPathname(route)).toBe(false);
    }
  });
});

describe("the normal app sign-in page is untouched by this change", () => {
  const SIGN_IN_PAGE = readFileSync(
    path.join(__dirname, "../../app/sign-in/page.tsx"),
    "utf8",
  );
  const AUTH_PAGE = readFileSync(
    path.join(__dirname, "../../../packages/permissions/src/pages.tsx"),
    "utf8",
  );

  it("/sign-in still delegates to the shared auth page, with no popup branch", () => {
    // The route is four lines and forwards `?next=`. Nothing about the widget
    // flow reaches it, and this pins that nothing ever quietly does — the
    // failure this guards against is a "shared" minimal mode that starts out
    // scoped to the popup and drifts onto the app's own sign-in.
    expect(SIGN_IN_PAGE).toContain("<PermissionsAuthPage");
    expect(SIGN_IN_PAGE).not.toMatch(/widget|popup|minimal|chromeless/i);
  });

  it("and the shared auth page still renders its own full surface", () => {
    // What the app's sign-in shows is NOT what the popup shows, and that is
    // deliberate: the bootstrap notice, the registration-closed notice and the
    // sign-up affordance all belong on the app's page. If a popup-shaped
    // condition ever appears here, the two surfaces have been merged and this
    // suite's whole premise — two contexts, one unchanged — is gone.
    expect(AUTH_PAGE).toContain("<BrandMark");
    expect(AUTH_PAGE).toContain("Create the first account");
    expect(AUTH_PAGE).toContain("Registration is closed");
    expect(AUTH_PAGE).not.toMatch(/widget|popup|minimal|chromeless/i);
  });
});

describe("the popup context cannot be aimed at the app", () => {
  it("no request-borne value reaches the decision", () => {
    // THE ANTI-SPOOF PROPERTY. The function takes one argument, a pathname, so
    // there is nothing for a crafted URL to carry: a query flag cannot strip the
    // chrome off an ordinary route, and cannot alter `/sign-in` either. Pinned
    // behaviourally — a flag-shaped search string appended to an app route
    // changes nothing, because the pathname is all that is read.
    for (const suffix of [
      "?widget=1",
      "?popup=1",
      "?minimal=1",
      "?embed=1",
      "?txn=forged",
    ]) {
      const url = new URL(`https://app.example.com/notifications${suffix}`);
      expect(bypassesAppShellForPathname(url.pathname)).toBe(false);
      const signIn = new URL(`https://app.example.com/sign-in${suffix}`);
      // …and `/sign-in` keeps the SAME answer it has with no query at all.
      expect(bypassesAppShellForPathname(signIn.pathname)).toBe(
        bypassesAppShellForPathname("/sign-in"),
      );
    }
  });

  it("and the source of the decision reads no search parameter", () => {
    // The behavioural test above can only probe the signature. This one pins the
    // body: a future edit that reaches for `window.location.search` or a
    // `searchParams` inside this function would compile and pass every case
    // above while re-opening exactly the hole the ruling's design avoided.
    const start = APP_SHELL_SRC.indexOf("export function bypassesAppShellForPathname");
    expect(start).toBeGreaterThan(-1);
    const body = APP_SHELL_SRC.slice(start, APP_SHELL_SRC.indexOf("\n}", start));
    expect(body).not.toMatch(/URLSearchParams|location\.search|searchParams|document\./);
    // The composition at the call site adds ONLY the legacy `?embed=1` mode,
    // which predates this and is unreachable from any route above.
    expect(APP_SHELL_SRC).toContain(
      "const shouldBypassShell = bypassesAppShellForPathname(pathname) || isEmbedMode;",
    );
  });
});
