// cinatra#2631 (codex rework round 3, finding 1) — THE MIXED-VERSION WINDOW.
//
// A rolling deploy runs two builds at once, and the hosted widget login spans
// three requests that can each land on a different node: the transaction is
// created by one, the signed-out page is rendered by another, and the grant is
// taken by a third. The provenance record on the transaction only means
// something if every value it can hold is either KNOWLEDGE or a refusal.
//
// The hole this suite pins shut: the record used to be created carrying the
// NO-SCREEN sentinel, which is a claim about the future. A NEW node created the
// transaction; an OLD node rendered its LEGACY signed-out page — naming none of
// the grants this build records, and writing nothing; after the login a NEW node
// read back the sentinel it had written itself and granted the new scopes to a
// person who never read them.
//
// So this suite drives the PAGE, which is where the two writes happen, and
// checks the whole ladder: what is on the transaction after each render, and
// what the person is shown.

import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

const getAuthSession = vi.fn();
const resolveOrgRoleForUser = vi.fn();
const loadActiveTransaction = vi.fn();
const recordDisplayedScopesForTransaction = vi.fn();
const sessionRowPredatesTransaction = vi.fn();
const emitWidgetAuthAudit = vi.fn();

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
  // The REAL fingerprint — the binding between the sentinel and the session it
  // was earned by is one of the properties under test.
  widgetSessionFingerprint: (id: unknown) =>
    typeof id === "string" && id.trim()
      ? createHash("sha256").update(id.trim()).digest("hex").slice(0, 32)
      : "",
}));
vi.mock("@/lib/widget-auth-audit", () => ({
  emitWidgetAuthAudit: (...a: unknown[]) => emitWidgetAuthAudit(...a),
}));
// The chrome is rendered, not exercised, here — stubbed so this test does not
// drag the app shell into a node environment.
vi.mock("@/components/layout/main", () => ({
  Main: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@/components/brand-mark", () => ({ BrandMark: () => null }));
vi.mock("@/components/widget-auth/widget-auth-login", () => ({
  WidgetAuthLogin: () => null,
}));
vi.mock("@/components/widget-auth/widget-auth-grant", () => ({
  WidgetAuthGrant: () => null,
}));

import {
  WIDGET_SIGNIN_GRANTED_SCOPES,
  WIDGET_SIGNIN_SCREEN_UNCLASSIFIED,
  widgetDisplayedScopesToken,
  widgetNoSignInScreenToken,
} from "@/lib/widget-lifecycle-scope";

import WidgetAuthPage from "../page";

const DISPLAYED = widgetDisplayedScopesToken(WIDGET_SIGNIN_GRANTED_SCOPES);

/**
 * The two answers the DATABASE can give about write order. `PRE_EXISTING` is the
 * session row that was already there when the transaction row was inserted;
 * `MINTED_DURING` is one written afterwards — a sign-in happened, somewhere.
 */
const PRE_EXISTING = true;
const MINTED_DURING = false;

const SESSION = { user: { id: "user-1" }, session: { id: "sess-1" } };

/** The no-screen sentinel one session would earn. */
const noScreenFor = (sessionId: string) =>
  widgetNoSignInScreenToken(
    createHash("sha256").update(sessionId).digest("hex").slice(0, 32),
  );

function txnRow(displayedScopes: string | null) {
  return {
    txnId: "txn-1",
    siteId: "site-1",
    client: "wordpress",
    orgId: "org-A",
    siteOrigin: "https://wp.test",
    agentSlug: "wordpress-content-editor",
    instanceId: "inst-1",
    codeChallenge: "c",
    state: "s",
    displayedScopes,
  };
}

/**
 * The transaction as a live row: the page's writes land on it exactly as the
 * store's write-once UPDATE would (it may only replace the unclassified value)
 * and every subsequent read sees the result.
 */
function liveTransaction(initial: string | null) {
  const row = txnRow(initial);
  loadActiveTransaction.mockImplementation((id: string) =>
    id === "txn-1" ? { ...row } : null,
  );
  recordDisplayedScopesForTransaction.mockImplementation(
    (id: string, offered: string) => {
      if (id !== "txn-1") return null;
      if (row.displayedScopes === WIDGET_SIGNIN_SCREEN_UNCLASSIFIED) {
        row.displayedScopes = offered;
      }
      return row.displayedScopes;
    },
  );
  return row;
}

async function render(): Promise<ReactElement> {
  return (await WidgetAuthPage({
    searchParams: Promise.resolve({ txn: "txn-1" }),
  })) as ReactElement;
}

/**
 * Every component name, text node and string prop in an element tree. The tree
 * is inspected rather than rendered to markup because component IDENTITY is half
 * of what is under test (the return step is a stub — what matters is whether the
 * page handed control to it at all), and the copy a person reads travels as a
 * prop on the error card.
 */
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

const shows = async (what: string) => flatten(await render()).join("\n").includes(what);

beforeEach(() => {
  vi.clearAllMocks();
  resolveOrgRoleForUser.mockResolvedValue("member");
  getAuthSession.mockResolvedValue(null);
  sessionRowPredatesTransaction.mockReturnValue(MINTED_DURING);
});

describe("an OLD node rendered the signed-out page — nothing is granted", () => {
  beforeEach(() => {
    // The legacy screen recorded nothing, so the transaction is still exactly as
    // it was created. The person signed in THERE, so the session is newer.
    liveTransaction(WIDGET_SIGNIN_SCREEN_UNCLASSIFIED);
    getAuthSession.mockResolvedValue(SESSION);
    sessionRowPredatesTransaction.mockReturnValue(MINTED_DURING);
  });

  it("refuses to hand the return step a transaction nobody accounted for", async () => {
    expect(await shows("<WidgetAuthGrant>")).toBe(false);
    expect(await shows("Cinatra was updated while this window was open")).toBe(true);
  });

  it("does NOT stamp the no-screen sentinel — a screen DID render, elsewhere", async () => {
    await render();
    expect(recordDisplayedScopesForTransaction).not.toHaveBeenCalled();
  });

  it("audits the refusal as a stale sign-in screen", async () => {
    await render();
    const denied = emitWidgetAuthAudit.mock.calls.find(([e]) => e === "consent_denied");
    expect(denied).toBeDefined();
    expect((denied as [string, Record<string, unknown>])[1].reason).toBe(
      "stale_signin_screen",
    );
  });

  it("leaves the transaction unclassified, so the ACTION would refuse it too", async () => {
    const row = liveTransaction(WIDGET_SIGNIN_SCREEN_UNCLASSIFIED);
    await render();
    expect(row.displayedScopes).toBe(WIDGET_SIGNIN_SCREEN_UNCLASSIFIED);
  });
});

describe("a session that ALREADY EXISTED — the sentinel is written, and earned", () => {
  beforeEach(() => {
    getAuthSession.mockResolvedValue(SESSION);
    sessionRowPredatesTransaction.mockReturnValue(PRE_EXISTING);
  });

  it("stamps the no-screen sentinel and goes straight to the return step", async () => {
    const row = liveTransaction(WIDGET_SIGNIN_SCREEN_UNCLASSIFIED);
    expect(await shows("<WidgetAuthGrant>")).toBe(true);
    expect(recordDisplayedScopesForTransaction).toHaveBeenCalledWith(
      "txn-1",
      noScreenFor("sess-1"),
    );
    expect(row.displayedScopes).toBe(noScreenFor("sess-1"));
  });

  it("stamps nothing for a LEGACY transaction, and refuses it", async () => {
    // Created by a node that predates the column: the write-once UPDATE matches
    // no row, the read comes back null, and null is not knowledge.
    const row = liveTransaction(null);
    expect(await shows("<WidgetAuthGrant>")).toBe(false);
    expect(row.displayedScopes).toBeNull();
  });

  it("is not reached by a non-member — the deny card comes first", async () => {
    liveTransaction(WIDGET_SIGNIN_SCREEN_UNCLASSIFIED);
    resolveOrgRoleForUser.mockResolvedValue(undefined);
    expect(await shows("not a member of the organization")).toBe(true);
    expect(recordDisplayedScopesForTransaction).not.toHaveBeenCalled();
  });
});

// codex rework round 5, finding 1 — the sentinel is a fact about ONE arrival.
describe("a sentinel stamped by someone else stands for nobody", () => {
  it("refuses the return step when the recorded sentinel names another session", () => {
    // The ordering the earlier tests could not reach: the transaction is
    // CLASSIFIED first (a member with a session made a bare GET on a new node,
    // stamping the sentinel and leaving the transaction unconsumed), and the
    // legacy screen renders AFTER, on an old node, for somebody else.
    const row = liveTransaction(noScreenFor("sess-a-member"));
    getAuthSession.mockResolvedValue(SESSION); // a different person, sess-1
    sessionRowPredatesTransaction.mockReturnValue(MINTED_DURING);
    return (async () => {
      expect(await shows("<WidgetAuthGrant>")).toBe(false);
      expect(await shows("Cinatra was updated while this window was open")).toBe(true);
      expect(row.displayedScopes).toBe(noScreenFor("sess-a-member"));
    })();
  });

  it("refuses it even for a session that DOES predate the transaction", () => {
    // The proof is about this arrival, and this arrival was never stamped: the
    // write-once record already belongs to someone else, so nothing here can
    // turn it into a statement about the person now at the screen.
    liveTransaction(noScreenFor("sess-a-member"));
    getAuthSession.mockResolvedValue(SESSION);
    sessionRowPredatesTransaction.mockReturnValue(PRE_EXISTING);
    return (async () => {
      expect(await shows("<WidgetAuthGrant>")).toBe(false);
    })();
  });
});

describe("this build rendered the sign-in screen — the ordinary path", () => {
  it("records what it is about to display, then admits the return after the login", async () => {
    const row = liveTransaction(WIDGET_SIGNIN_SCREEN_UNCLASSIFIED);

    // 1. Signed out: this build's screen renders and records its displayed set.
    expect(await shows("<WidgetAuthLogin>")).toBe(true);
    expect(recordDisplayedScopesForTransaction).toHaveBeenCalledWith("txn-1", DISPLAYED);
    expect(row.displayedScopes).toBe(DISPLAYED);

    // 2. The person signs in there, so the session row is NEWER than the
    //    transaction — and the record already says what they read.
    getAuthSession.mockResolvedValue(SESSION);
    expect(await shows("<WidgetAuthGrant>")).toBe(true);
    expect(row.displayedScopes).toBe(DISPLAYED);
  });

  it("refuses the return when the recorded screen showed a DIFFERENT set", async () => {
    // The other half of the window: a node of a different generation rendered
    // the screen and recorded what IT displayed. This build would record
    // something else, so the person read the wrong sentences.
    liveTransaction(`${DISPLAYED} some.other`);
    getAuthSession.mockResolvedValue(SESSION);
    expect(await shows("<WidgetAuthGrant>")).toBe(false);
    expect(await shows("Cinatra was updated while this window was open")).toBe(true);
  });

  it("refuses the screen itself when another build already recorded a different set", async () => {
    // Unchanged from rework round 2, finding 1, and re-pinned here because the
    // claimable value changed underneath it: the screen may not render its own
    // list over a record that says something else.
    liveTransaction("lifecycle.read lifecycle.decide");
    expect(await shows("<WidgetAuthLogin>")).toBe(false);
    expect(await shows("Cinatra was updated while this window was open")).toBe(true);
  });
});

describe("the proof cannot be forged from the browser", () => {
  it("asks about the SESSION ROW and the TRANSACTION ROW, and nothing else", async () => {
    liveTransaction(WIDGET_SIGNIN_SCREEN_UNCLASSIFIED);
    getAuthSession.mockResolvedValue(SESSION);
    sessionRowPredatesTransaction.mockReturnValue(PRE_EXISTING);
    await render();
    expect(sessionRowPredatesTransaction).toHaveBeenCalledWith("sess-1", "txn-1");
  });

  it("an unprovable session is refused and stamps nothing", async () => {
    const row = liveTransaction(WIDGET_SIGNIN_SCREEN_UNCLASSIFIED);
    getAuthSession.mockResolvedValue({ user: { id: "user-1" }, session: {} });
    sessionRowPredatesTransaction.mockReturnValue(MINTED_DURING);
    expect(await shows("<WidgetAuthGrant>")).toBe(false);
    expect(row.displayedScopes).toBe(WIDGET_SIGNIN_SCREEN_UNCLASSIFIED);
  });

  it("no search param participates in the proof", async () => {
    liveTransaction(WIDGET_SIGNIN_SCREEN_UNCLASSIFIED);
    getAuthSession.mockResolvedValue(SESSION);
    const tree = flatten(
      (await WidgetAuthPage({
        // Everything a caller could try to say about the flow, said at once.
        searchParams: Promise.resolve({
          txn: "txn-1",
          displayed: DISPLAYED,
          s: DISPLAYED,
          noscreen: "1",
          created: "2020-01-01T00:00:00.000Z",
        }),
      })) as ReactElement,
    ).join("\n");
    expect(tree).not.toContain("<WidgetAuthGrant>");
    expect(tree).toContain("Cinatra was updated while this window was open");
  });
});
