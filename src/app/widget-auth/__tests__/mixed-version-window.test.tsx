// cinatra#2631 (codex rework rounds 3 and 7) — THE MIXED-VERSION WINDOW.
//
// A rolling deploy runs two builds at once, and the hosted widget login spans
// three requests that can each land on a different node: the transaction is
// created by one, the signed-out page is rendered by another, and the grant is
// taken by a third. The provenance record on the transaction only means
// something if every value it can hold is either KNOWLEDGE or a refusal — and if
// the knowledge is about THE PERSON REDEEMING IT.
//
// Two holes this suite pins shut:
//
//   • round 3 — the record used to be created carrying the NO-SCREEN sentinel,
//     which is a claim about the future. A NEW node created the transaction; an
//     OLD node rendered its LEGACY signed-out page — naming none of the grants
//     this build records, and writing nothing; after the login a NEW node read
//     back the sentinel it had written itself and granted the new scopes to a
//     person who never read them.
//
//   • round 7 — a REAL displayed-set record was a property of the TRANSACTION
//     rather than of the arrival that redeems it. Person A opens the transaction
//     sessionless on a current node, which records the current set, and abandons
//     it; person B opens the SAME unconsumed transaction on a legacy node, reads
//     the legacy copy, signs in there and returns to a current node — which
//     admitted A's record and issued B a code for sentences B never saw. The
//     record now carries the hash of a single-use nonce the recording node hands
//     to that one browser, and nothing redeems it without presenting that nonce.
//
// So this suite drives the PAGE, which is where the writes and the hop happen,
// and checks the whole ladder: what is on the transaction after each render,
// where the browser is sent, and what the person is shown.

import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

const getAuthSession = vi.fn();
const resolveOrgRoleForUser = vi.fn();
const loadActiveTransaction = vi.fn();
const recordDisplayedScopesForTransaction = vi.fn();
const sessionRowPredatesTransaction = vi.fn();
const emitWidgetAuthAudit = vi.fn();

/** What `redirect()` does in a server component: it throws and the render stops. */
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

/** Deterministic mints, so a test can name the nonce the page just handed out. */
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
  // The REAL fingerprint — the binding between the sentinel and the session it
  // was earned by is one of the properties under test.
  widgetSessionFingerprint: (id: unknown) =>
    typeof id === "string" && id.trim()
      ? createHash("sha256").update(id.trim()).digest("hex").slice(0, 32)
      : "",
  // Likewise real: whether an arrival can present the nonce its record was
  // written with is the property round 7 is about. Only the RANDOMNESS is
  // replaced, so the test can name what the page minted.
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
/** A DIFFERENT person at the same transaction (round 7's person B). */
const OTHER_SESSION = { user: { id: "user-2" }, session: { id: "sess-2" } };

/** The no-screen sentinel one session would earn. */
const noScreenFor = (sessionId: string) =>
  widgetNoSignInScreenToken(
    createHash("sha256").update(sessionId).digest("hex").slice(0, 32),
  );

/** A nonce no node in this flow ever minted — what an arrival guesses with. */
const FOREIGN_NONCE = createHash("sha256").update("person-B-invented-this").digest("hex");

function txnRow(displayedScopes: string | null, screenNonceHash: string | null) {
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
    screenNonceHash,
  };
}

/**
 * The transaction as a live row: the page's writes land on it exactly as the
 * store's write-once UPDATE would — the guard names BOTH columns, so a record
 * may only replace the unclassified value while no arrival is attached — and
 * every subsequent read sees the result.
 */
function liveTransaction(initial: string | null, initialNonceHash: string | null = null) {
  const row = txnRow(initial, initialNonceHash);
  loadActiveTransaction.mockImplementation((id: string) =>
    id === "txn-1" ? { ...row } : null,
  );
  recordDisplayedScopesForTransaction.mockImplementation(
    (id: string, offered: string, nonceHash: string) => {
      if (id !== "txn-1") return null;
      // A caller that cannot name its arrival writes nothing at all.
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

type Outcome = { tree: ReactElement | null; redirectedTo: string | null };

async function visit(
  searchParams: Record<string, string | string[] | undefined> = { txn: "txn-1" },
): Promise<Outcome> {
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

const textOf = (outcome: Outcome) => flatten(outcome.tree).join("\n");
const shows = async (what: string) => textOf(await visit()).includes(what);

/** The nonce a URL the page redirected to carries. */
function nonceIn(url: string | null): string {
  return new URLSearchParams((url ?? "").split("?")[1] ?? "").get("n") ?? "";
}

beforeEach(() => {
  vi.clearAllMocks();
  minted = [];
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
    await visit();
    expect(recordDisplayedScopesForTransaction).not.toHaveBeenCalled();
  });

  it("audits the refusal", async () => {
    await visit();
    const denied = emitWidgetAuthAudit.mock.calls.find(([e]) => e === "consent_denied");
    expect(denied).toBeDefined();
    expect((denied as [string, Record<string, unknown>])[1].reason).toBe(
      "screen_nonce_mismatch",
    );
  });

  it("leaves the transaction unclassified, so the ACTION would refuse it too", async () => {
    const row = liveTransaction(WIDGET_SIGNIN_SCREEN_UNCLASSIFIED);
    await visit();
    expect(row.displayedScopes).toBe(WIDGET_SIGNIN_SCREEN_UNCLASSIFIED);
    expect(row.screenNonceHash).toBeNull();
  });
});

describe("a session that ALREADY EXISTED — the sentinel is written, and earned", () => {
  beforeEach(() => {
    getAuthSession.mockResolvedValue(SESSION);
    sessionRowPredatesTransaction.mockReturnValue(PRE_EXISTING);
  });

  it("stamps the no-screen sentinel with its own nonce and hops to carry it", async () => {
    const row = liveTransaction(WIDGET_SIGNIN_SCREEN_UNCLASSIFIED);
    const first = await visit();
    expect(first.redirectedTo).toBe(`/widget-auth?txn=txn-1&n=${minted[0]}`);
    expect(recordDisplayedScopesForTransaction).toHaveBeenCalledWith(
      "txn-1",
      noScreenFor("sess-1"),
      realNonceHash(minted[0]),
    );
    expect(row.displayedScopes).toBe(noScreenFor("sess-1"));
    expect(row.screenNonceHash).toBe(realNonceHash(minted[0]));

    // ...and the arrival that comes back carrying it goes to the return step.
    const second = await visit({ txn: "txn-1", n: minted[0] });
    expect(textOf(second)).toContain("<WidgetAuthGrant>");
    expect(recordDisplayedScopesForTransaction).toHaveBeenCalledTimes(1);
  });

  it("stamps nothing for a LEGACY transaction, and refuses it", async () => {
    // Created by a node that predates the column: the write-once UPDATE matches
    // no row, the read comes back saying nothing is known, and that is not
    // knowledge.
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
  it("refuses the return step when the recorded sentinel names another session", async () => {
    // The ordering the earlier tests could not reach: the transaction is
    // CLASSIFIED first (a member with a session made a bare GET on a new node,
    // stamping the sentinel and leaving the transaction unconsumed), and the
    // legacy screen renders AFTER, on an old node, for somebody else. Even
    // holding that member's nonce, the sentinel names a session this arrival
    // does not have.
    const memberNonce = createHash("sha256").update("member").digest("hex");
    const row = liveTransaction(noScreenFor("sess-a-member"), realNonceHash(memberNonce));
    getAuthSession.mockResolvedValue(SESSION); // a different person, sess-1
    sessionRowPredatesTransaction.mockReturnValue(MINTED_DURING);
    const outcome = await visit({ txn: "txn-1", n: memberNonce });
    expect(textOf(outcome)).not.toContain("<WidgetAuthGrant>");
    expect(textOf(outcome)).toContain("Cinatra was updated while this window was open");
    expect(row.displayedScopes).toBe(noScreenFor("sess-a-member"));
  });

  it("refuses it even for a session that DOES predate the transaction", async () => {
    // The proof is about this arrival, and this arrival was never stamped: the
    // write-once record already belongs to someone else, so nothing here can
    // turn it into a statement about the person now at the screen.
    liveTransaction(noScreenFor("sess-a-member"), realNonceHash(FOREIGN_NONCE));
    getAuthSession.mockResolvedValue(SESSION);
    sessionRowPredatesTransaction.mockReturnValue(PRE_EXISTING);
    expect(await shows("<WidgetAuthGrant>")).toBe(false);
  });
});

describe("this build rendered the sign-in screen — the ordinary path", () => {
  it("records what it is about to display, hops to carry the nonce, then admits the return", async () => {
    const row = liveTransaction(WIDGET_SIGNIN_SCREEN_UNCLASSIFIED);

    // 1. Signed out: this build's screen records its displayed set together with
    //    the nonce that names this arrival, then sends the browser to the URL
    //    carrying it. Nothing is rendered on that hop.
    const first = await visit();
    expect(recordDisplayedScopesForTransaction).toHaveBeenCalledWith(
      "txn-1",
      DISPLAYED,
      realNonceHash(minted[0]),
    );
    expect(row.displayedScopes).toBe(DISPLAYED);
    expect(row.screenNonceHash).toBe(realNonceHash(minted[0]));
    expect(nonceIn(first.redirectedTo)).toBe(minted[0]);

    // 2. The screen itself renders on the arrival that carries the nonce, and
    //    writes nothing more.
    const screen = await visit({ txn: "txn-1", n: minted[0] });
    expect(textOf(screen)).toContain("<WidgetAuthLogin>");
    expect(recordDisplayedScopesForTransaction).toHaveBeenCalledTimes(1);

    // 3. The person signs in there, so the session row is NEWER than the
    //    transaction — and the record already says what they read, to them.
    getAuthSession.mockResolvedValue(SESSION);
    const returned = await visit({ txn: "txn-1", n: minted[0] });
    expect(textOf(returned)).toContain("<WidgetAuthGrant>");
    expect(row.displayedScopes).toBe(DISPLAYED);
  });

  it("is REFRESH-SAFE: re-reading the screen writes nothing and keeps working", async () => {
    // The hop is what buys this. Without a nonce in the URL, a plain reload would
    // mint a second nonce, lose the write-once race against its own earlier one
    // and dead-end a person who did nothing wrong.
    liveTransaction(WIDGET_SIGNIN_SCREEN_UNCLASSIFIED);
    const nonce = nonceIn((await visit()).redirectedTo);
    for (let i = 0; i < 3; i += 1) {
      const again = await visit({ txn: "txn-1", n: nonce });
      expect(again.redirectedTo).toBeNull();
      expect(textOf(again)).toContain("<WidgetAuthLogin>");
    }
    expect(recordDisplayedScopesForTransaction).toHaveBeenCalledTimes(1);
  });

  it("hands the return step the nonce it was carrying", async () => {
    liveTransaction(WIDGET_SIGNIN_SCREEN_UNCLASSIFIED);
    const nonce = nonceIn((await visit()).redirectedTo);
    getAuthSession.mockResolvedValue(SESSION);
    // The grant component is a stub here, so read the prop off the element.
    const outcome = await visit({ txn: "txn-1", n: nonce });
    expect(textOf(outcome)).toContain(nonce);
  });

  it("refuses the return when the recorded screen showed a DIFFERENT set", async () => {
    // The other half of the window: a node of a different generation rendered
    // the screen and recorded what IT displayed. This build would record
    // something else, so the person read the wrong sentences — and holding the
    // right nonce does not change what they read.
    liveTransaction(`${DISPLAYED} some.other`, realNonceHash(FOREIGN_NONCE));
    getAuthSession.mockResolvedValue(SESSION);
    const outcome = await visit({ txn: "txn-1", n: FOREIGN_NONCE });
    expect(textOf(outcome)).not.toContain("<WidgetAuthGrant>");
    expect(textOf(outcome)).toContain("Cinatra was updated while this window was open");
  });

  it("refuses the screen itself when another build already recorded a different set", async () => {
    // Unchanged from rework round 2, finding 1, and re-pinned here because the
    // claimable value changed underneath it: the screen may not render its own
    // list over a record that says something else.
    liveTransaction("lifecycle.read lifecycle.decide", realNonceHash(FOREIGN_NONCE));
    expect(await shows("<WidgetAuthLogin>")).toBe(false);
    expect(await shows("Cinatra was updated while this window was open")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// codex rework round 7, finding 1 — ONE TRANSACTION, TWO PEOPLE.
//
// The whole exploit, replayed through the page in BOTH orderings. Person A is
// sessionless on a CURRENT node; person B is walked through a LEGACY node's
// sign-in screen — which names none of the grants this build records and writes
// nothing — and then returns to a current node holding a session.
// ---------------------------------------------------------------------------
describe("one transaction driven by two people", () => {
  /** Person B comes back from the legacy node's screen. */
  async function personBReturns(presented?: string): Promise<Outcome> {
    getAuthSession.mockResolvedValue(OTHER_SESSION);
    sessionRowPredatesTransaction.mockReturnValue(MINTED_DURING); // B just signed in
    return visit(presented ? { txn: "txn-1", n: presented } : { txn: "txn-1" });
  }

  it("ORDERING 1 — A's screen recorded first, then B signed in on the legacy node", async () => {
    const row = liveTransaction(WIDGET_SIGNIN_SCREEN_UNCLASSIFIED);

    // A opens it sessionless on a current node. The set is recorded, the nonce
    // is minted, and A walks away without signing in.
    const aNonce = nonceIn((await visit()).redirectedTo);
    expect(row.displayedScopes).toBe(DISPLAYED);
    expect(aNonce).toBe(minted[0]);

    // B reads the LEGACY copy on an old node, signs in there and lands here.
    const outcome = await personBReturns();
    expect(textOf(outcome)).not.toContain("<WidgetAuthGrant>");
    expect(textOf(outcome)).toContain("Cinatra was updated while this window was open");
    // Nothing was issued and nothing was rewritten: A's record is still A's.
    expect(row.displayedScopes).toBe(DISPLAYED);
    expect(row.screenNonceHash).toBe(realNonceHash(aNonce));
  });

  it("ORDERING 2 — B's legacy screen came first, A's current screen recorded after", async () => {
    // The legacy node writes nothing, so the transaction is still unclassified
    // when A's screen claims it. B returns to a record that was never about B.
    const row = liveTransaction(WIDGET_SIGNIN_SCREEN_UNCLASSIFIED);
    const outcomeBeforeA = await personBReturns();
    expect(textOf(outcomeBeforeA)).not.toContain("<WidgetAuthGrant>");
    expect(row.displayedScopes).toBe(WIDGET_SIGNIN_SCREEN_UNCLASSIFIED);

    getAuthSession.mockResolvedValue(null);
    const aNonce = nonceIn((await visit()).redirectedTo);
    expect(row.screenNonceHash).toBe(realNonceHash(aNonce));

    const outcomeAfterA = await personBReturns();
    expect(textOf(outcomeAfterA)).not.toContain("<WidgetAuthGrant>");
    expect(textOf(outcomeAfterA)).toContain("Cinatra was updated while this window was open");
  });

  it("B cannot guess, replay a hash, or strip their way in", async () => {
    liveTransaction(WIDGET_SIGNIN_SCREEN_UNCLASSIFIED);
    const aNonce = nonceIn((await visit()).redirectedTo);
    for (const presented of [
      FOREIGN_NONCE, // invented
      realNonceHash(aNonce), // the STORED value, replayed as if it were the nonce
      aNonce.slice(0, 63), // truncated
      `${aNonce} `, // padded
      "", // stripped
    ]) {
      const outcome = await personBReturns(presented);
      expect(textOf(outcome)).not.toContain("<WidgetAuthGrant>");
    }
  });

  it("B cannot take the no-screen route either, even holding an OLDER session", async () => {
    // B's session predates the transaction, so B would otherwise earn the
    // sentinel — but the record is write-once and already belongs to A, so there
    // is nothing for B's proof to write and nothing that names B.
    const row = liveTransaction(WIDGET_SIGNIN_SCREEN_UNCLASSIFIED);
    await visit(); // A records
    getAuthSession.mockResolvedValue(OTHER_SESSION);
    sessionRowPredatesTransaction.mockReturnValue(PRE_EXISTING);
    const outcome = await visit();
    expect(textOf(outcome)).not.toContain("<WidgetAuthGrant>");
    expect(row.displayedScopes).toBe(DISPLAYED);
  });

  it("and A — the person who actually read the screen — is still let through", async () => {
    // The exploit closes without closing the flow: the discriminator is real.
    liveTransaction(WIDGET_SIGNIN_SCREEN_UNCLASSIFIED);
    const aNonce = nonceIn((await visit()).redirectedTo);
    getAuthSession.mockResolvedValue(SESSION);
    sessionRowPredatesTransaction.mockReturnValue(MINTED_DURING);
    expect(textOf(await visit({ txn: "txn-1", n: aNonce }))).toContain(
      "<WidgetAuthGrant>",
    );
  });

  it("a record left by a node that predates the NONCE admits nobody", async () => {
    // This mechanism's own rolling deploy: the previous build recorded a
    // displayed set and no arrival. It fails closed like the unclassified value,
    // and no later arrival can adopt it.
    const row = liveTransaction(DISPLAYED, null);
    getAuthSession.mockResolvedValue(SESSION);
    sessionRowPredatesTransaction.mockReturnValue(PRE_EXISTING);
    const outcome = await visit();
    expect(textOf(outcome)).not.toContain("<WidgetAuthGrant>");
    expect(row.screenNonceHash).toBeNull();
  });
});

describe("the proof cannot be forged from the browser", () => {
  it("asks about the SESSION ROW and the TRANSACTION ROW, and nothing else", async () => {
    liveTransaction(WIDGET_SIGNIN_SCREEN_UNCLASSIFIED);
    getAuthSession.mockResolvedValue(SESSION);
    sessionRowPredatesTransaction.mockReturnValue(PRE_EXISTING);
    await visit();
    expect(sessionRowPredatesTransaction).toHaveBeenCalledWith("sess-1", "txn-1");
  });

  it("an unprovable session is refused and stamps nothing", async () => {
    const row = liveTransaction(WIDGET_SIGNIN_SCREEN_UNCLASSIFIED);
    getAuthSession.mockResolvedValue({ user: { id: "user-1" }, session: {} });
    sessionRowPredatesTransaction.mockReturnValue(MINTED_DURING);
    expect(await shows("<WidgetAuthGrant>")).toBe(false);
    expect(row.displayedScopes).toBe(WIDGET_SIGNIN_SCREEN_UNCLASSIFIED);
  });

  it("no search param CLAIMS anything — the one that is read is a secret, not an assertion", async () => {
    // The nonce is the single parameter this page reads besides the transaction
    // id, and it cannot assert: it is compared against a hash the server stored,
    // so a value nobody minted buys exactly nothing. Everything a caller might
    // try to SAY about the flow stays inert.
    liveTransaction(WIDGET_SIGNIN_SCREEN_UNCLASSIFIED, realNonceHash(FOREIGN_NONCE));
    getAuthSession.mockResolvedValue(SESSION);
    const outcome = await visit({
      txn: "txn-1",
      n: `${FOREIGN_NONCE.slice(0, 63)}0`,
      displayed: DISPLAYED,
      s: DISPLAYED,
      noscreen: "1",
      created: "2020-01-01T00:00:00.000Z",
    });
    expect(textOf(outcome)).not.toContain("<WidgetAuthGrant>");
    expect(textOf(outcome)).toContain("Cinatra was updated while this window was open");
  });
});
