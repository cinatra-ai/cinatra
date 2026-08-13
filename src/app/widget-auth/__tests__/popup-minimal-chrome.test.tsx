// ---------------------------------------------------------------------------
// OWNER RULING 2026-08-13 — THE POPUP SHOWS THE SIGN-IN FORM AND NOTHING ELSE.
//
// Two things were wrong with the widget sign-in popup: the app shell wrapped it
// (sidebar, breadcrumb bar, notifications bell — pinned off in
// `src/components/__tests__/widget-auth-popup-chrome.test.ts`), and the page
// itself printed a paragraph and a bulleted scope list BELOW the form. This
// suite is about the second half: what the page returns.
//
// WHY A RENDER TEST AND NOT A GREP. "No text below the form" is a property of
// the TREE, and a grep for the sentences that were removed would keep passing if
// somebody added different ones. So the signed-out branch is rendered and the
// whole tree is flattened: every element name, every text node and every string
// prop. The assertion is over that flattening — nothing but the shell, the brand
// mark and the sign-in view may be in it.
//
// The premise is pinned too. A page that stopped rendering the sign-in view at
// all would satisfy "no text" perfectly, and would be a broken login window.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";

const getAuthSession = vi.fn();
const resolveOrgRoleForUser = vi.fn();
const loadActiveTransaction = vi.fn();
const recordDisplayedScopesForTransaction = vi.fn();
const sessionRowPredatesTransaction = vi.fn();
const emitWidgetAuthAudit = vi.fn();

class Redirected extends Error {
  constructor(readonly to: string) {
    super(`NEXT_REDIRECT:${to}`);
  }
}

vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Redirected(to);
  },
}));

let minted: string[] = [];
const realNonceHash = (nonce: unknown) =>
  typeof nonce === "string" && /^[a-f0-9]{64}$/.test(nonce)
    ? createHash("sha256").update(nonce).digest("hex")
    : "";

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: (...a: unknown[]) => getAuthSession(...a),
  resolveOrgRoleForUser: (...a: unknown[]) => resolveOrgRoleForUser(...a),
}));
vi.mock("@/lib/widget-user-auth", () => ({
  loadActiveTransaction: (...a: unknown[]) => loadActiveTransaction(...a),
  recordDisplayedScopesForTransaction: (...a: unknown[]) =>
    recordDisplayedScopesForTransaction(...a),
  sessionRowPredatesTransaction: (...a: unknown[]) =>
    sessionRowPredatesTransaction(...a),
  widgetSessionFingerprint: (id: unknown) =>
    typeof id === "string" && id.trim()
      ? createHash("sha256").update(id.trim()).digest("hex").slice(0, 32)
      : "",
  widgetScreenNonceHash: (nonce: unknown) => realNonceHash(nonce),
  mintWidgetScreenNonce: () => {
    const nonce = createHash("sha256").update(`minted:${minted.length}`).digest("hex");
    minted.push(nonce);
    return nonce;
  },
}));
vi.mock("@/lib/widget-auth-audit", () => ({
  emitWidgetAuthAudit: (...a: unknown[]) => emitWidgetAuthAudit(...a),
}));
// Named stubs, so the flattening below can tell "the brand mark is here" from
// "something rendered". `Main` passes children through — it is a <main> wrapper
// in production and contributes no copy of its own.
vi.mock("@/components/layout/main", () => ({
  Main: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@/components/brand-mark", () => ({
  BrandMark: function BrandMark() {
    return <span data-brand-mark="1" />;
  },
}));
// The sign-in view is the shared AuthView; it is STUBBED so what the markup
// below shows is exactly what THIS PAGE contributes around the form.
vi.mock("@/components/widget-auth/widget-auth-login", () => ({
  WidgetAuthLogin: function WidgetAuthLogin() {
    return <form data-sign-in-form="1" />;
  },
}));
vi.mock("@/components/widget-auth/widget-auth-grant", () => ({
  WidgetAuthGrant: function WidgetAuthGrant() {
    return <span data-return-step="1" />;
  },
}));

import {
  WIDGET_EXTENSION_SCOPES,
  WIDGET_SIGNIN_GRANTED_SCOPES,
  WIDGET_SIGNIN_SCREEN_UNCLASSIFIED,
  widgetDisplayedScopesToken,
} from "@/lib/widget-lifecycle-scope";

import WidgetAuthPage from "../page";

const DISPLAYED = widgetDisplayedScopesToken(WIDGET_SIGNIN_GRANTED_SCOPES);
const SESSION = { user: { id: "user-1" }, session: { id: "sess-1" } };

function liveTransaction() {
  const row = {
    txnId: "txn-1",
    siteId: "site-1",
    client: "wordpress",
    orgId: "org-A",
    siteOrigin: "https://wp.test",
    agentSlug: "wordpress-content-editor",
    instanceId: "inst-1",
    codeChallenge: "c",
    state: "s",
    displayedScopes: WIDGET_SIGNIN_SCREEN_UNCLASSIFIED as string | null,
    screenNonceHash: null as string | null,
  };
  loadActiveTransaction.mockImplementation((id: string) =>
    id === "txn-1" ? { ...row } : null,
  );
  recordDisplayedScopesForTransaction.mockImplementation(
    (id: string, offered: string, nonceHash: string) => {
      if (id !== "txn-1") return null;
      if (!/^[a-f0-9]{64}$/.test(String(nonceHash ?? ""))) return null;
      if (
        row.displayedScopes === WIDGET_SIGNIN_SCREEN_UNCLASSIFIED &&
        row.screenNonceHash === null
      ) {
        row.displayedScopes = offered;
        row.screenNonceHash = nonceHash;
      }
      return {
        displayedScopes: row.displayedScopes,
        screenNonceHash: row.screenNonceHash,
      };
    },
  );
  return row;
}

/** Every component name, text node and string prop in the returned tree. */
function flatten(node: unknown, out: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === "boolean") return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  const el = node as { type?: unknown; props?: Record<string, unknown> };
  if (el.type) {
    const name =
      typeof el.type === "string"
        ? el.type
        : ((el.type as { name?: string }).name ?? "anonymous");
    out.push(`<${name}>`);
  }
  for (const [key, value] of Object.entries(el.props ?? {})) {
    if (key === "children") flatten(value, out);
    else if (typeof value === "string") out.push(value);
  }
  return out;
}

/** The element names in a tree, in order. */
const elementsOf = (parts: string[]) =>
  parts.filter((p) => /^<[^>]+>$/.test(p)).map((p) => p.slice(1, -1));

async function visit(
  searchParams: Record<string, string | string[] | undefined>,
): Promise<{ tree: ReactElement | null; redirectedTo: string | null }> {
  try {
    const tree = (await WidgetAuthPage({
      searchParams: Promise.resolve(searchParams),
    })) as ReactElement;
    return { tree, redirectedTo: null };
  } catch (error) {
    if (error instanceof Redirected) return { tree: null, redirectedTo: error.to };
    throw error;
  }
}

/** Follow the one nonce hop the page makes, and return the screen. */
async function openSignInScreen(): Promise<{ parts: string[]; html: string }> {
  const first = await visit({ txn: "txn-1" });
  const nonce = new URL(
    `https://app.test${first.redirectedTo ?? ""}`,
  ).searchParams.get("n");
  const second = await visit({ txn: "txn-1", n: nonce ?? "" });
  return {
    parts: flatten(second.tree),
    html: second.tree ? renderToStaticMarkup(second.tree) : "",
  };
}

/** Everything a person could READ in a rendered document: tags stripped. */
const readableText = (html: string) =>
  html
    .replace(/<[^>]*>/g, " ")
    .replace(/&[a-z]+;|&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

beforeEach(() => {
  vi.clearAllMocks();
  minted = [];
  getAuthSession.mockResolvedValue(null);
  sessionRowPredatesTransaction.mockReturnValue(false);
  liveTransaction();
});

describe("the popup's sign-in screen", () => {
  it("still renders the sign-in view — the premise of every case below", async () => {
    // Without this, "no text on the screen" would be satisfied by a blank page.
    const { parts, html } = await openSignInScreen();
    expect(elementsOf(parts)).toContain("WidgetAuthLogin");
    expect(html).toContain("data-sign-in-form");
  });

  it("hands the shell exactly ONE child — the form", async () => {
    const { parts } = await openSignInScreen();
    expect(elementsOf(parts)).toEqual(["Shell", "WidgetAuthLogin"]);
  });

  it("keeps the brand mark, and prints NO copy of its own", async () => {
    const { html } = await openSignInScreen();
    // The design system's own sign-in identity — the brand mark above the form —
    // is what the ruling calls "minimal branding", and it stays.
    expect(html).toContain("data-brand-mark");
    // The sign-in view is stubbed, so everything readable in this document is
    // what the PAGE contributed around the form. There is none: no paragraph, no
    // heading, no bulleted list, no footer sentence.
    expect(readableText(html)).toBe("");
  });

  it("names none of the scope sentences that used to sit under the form", async () => {
    const { html } = await openSignInScreen();
    // Enumerated from the vocabulary, so a scope added later is covered too.
    expect(WIDGET_SIGNIN_GRANTED_SCOPES.length).toBeGreaterThan(0);
    for (const scope of WIDGET_SIGNIN_GRANTED_SCOPES) {
      expect(html).not.toContain(WIDGET_EXTENSION_SCOPES[scope].consentCopy);
    }
    expect(html).not.toContain("Signing in connects");
    expect(html).not.toContain("will be allowed to");
    // The client label the removed paragraph interpolated is gone with it.
    expect(html).not.toContain("WordPress");
  });

  it("still records what the transaction is entitled to, server-side", async () => {
    // The chrome ruling changed the SCREEN, not the record. This is the half of
    // the mixed-version seal that lives on the signed-out branch.
    await openSignInScreen();
    expect(recordDisplayedScopesForTransaction).toHaveBeenCalledWith(
      "txn-1",
      DISPLAYED,
      expect.stringMatching(/^[a-f0-9]{64}$/),
    );
  });
});

describe("the rest of the flow is untouched", () => {
  it("a signed-in member still goes straight to the return step", async () => {
    getAuthSession.mockResolvedValue(SESSION);
    resolveOrgRoleForUser.mockResolvedValue("member");
    sessionRowPredatesTransaction.mockReturnValue(true);
    const first = await visit({ txn: "txn-1" });
    const nonce = new URL(
      `https://app.test${first.redirectedTo ?? ""}`,
    ).searchParams.get("n");
    const parts = flatten((await visit({ txn: "txn-1", n: nonce ?? "" })).tree);
    expect(elementsOf(parts)).toContain("WidgetAuthGrant");
  });

  it("an invalid transaction still shows the neutral error card", async () => {
    loadActiveTransaction.mockReturnValue(null);
    const outcome = await visit({ txn: "nope" });
    const html = outcome.tree ? renderToStaticMarkup(outcome.tree) : "";
    // The error card is not "text below the form" — there is no form on that
    // branch at all, and a popup that explains nothing is a dead end.
    expect(readableText(html)).toContain("Cannot sign in");
    expect(html).not.toContain("data-sign-in-form");
  });
});
