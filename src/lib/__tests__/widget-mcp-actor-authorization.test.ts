/**
 * THE WIDGET OBO TOKEN IS SEALED TO ITS TURN AND TO ITS SIGN-IN (cinatra#2687).
 *
 * The token always said "this turn only". Nothing enforced it: `jti` was
 * required and returned, and no code anywhere compared it to a turn. So the
 * token authorized for its whole 120 seconds — after the turn had finished, and
 * after the person had signed out — anywhere the hosted relay presented it.
 *
 * This suite is the acceptance for closing that. Every refusal below is paired
 * with the control that must still pass, and two of them are NEGATIVE CONTROLS
 * in the strict sense the issue asks for: they assert that the raw token
 * verifier — the code that existed before this change — STILL ACCEPTS the exact
 * same token. That is what makes the refusal attributable to the new check and
 * not to some incidental claim-shape strictness, and it is what fails if the
 * new check is deleted while the rest of the change stays.
 *
 * The two store reads are mocked as data switches, because that is what they
 * are from here: "the sign-in ended" and "the turn finished" are states, and a
 * test that could only produce them by driving Postgres would be testing
 * Postgres. The predicates themselves are covered where they live —
 * `widget-session-binding.test.ts` and the `assistant_turns` store suite — and
 * the real-database tier for the session half landed with #2685.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const PUBLIC_BASE_URL = "https://cinatra-test.tailnet000.ts.net";
const PUBLIC_MCP_URL = `${PUBLIC_BASE_URL}/api/mcp`;
const PUBLIC_AUTH_URL = `${PUBLIC_BASE_URL}/api/auth`;

vi.mock("@cinatra-ai/mcp-server/credentials", () => ({
  getLocalMcpServerUrl: (path: string) => `http://localhost:3000${path}`,
  getPublicMcpServerUrl: () => PUBLIC_MCP_URL,
}));

// The two store seams, as data switches. `readWidgetTokenParentLiveness` is the
// SHARED reader from #2684 — the same function the token verifier, the capture
// probe and the chat resume route ask; the drift pin below holds that.
const readWidgetTokenParentLiveness = vi.fn(
  (_jti: unknown): "live" | "dead" | "unknown" => "live",
);
const readAssistantTurnActivityByRunId = vi.fn(
  (_runId: unknown): "active" | "ended" | "unknown" => "active",
);

vi.mock("@/lib/widget-session-binding", () => ({
  readWidgetTokenParentLiveness: (jti: unknown) => readWidgetTokenParentLiveness(jti),
}));
vi.mock("@/lib/assistant-thread-store", () => ({
  readAssistantTurnActivityByRunId: (runId: unknown) =>
    readAssistantTurnActivityByRunId(runId),
}));

import {
  resolveWidgetDelegatedActorForTransport,
  verifyLiveWidgetMcpActor,
} from "../widget-mcp-actor-authorization";
import {
  issueWidgetMcpActorToken,
  verifyWidgetMcpActorToken,
  type WidgetMcpActorTokenInput,
} from "../widget-mcp-actor-token";

const INPUT: WidgetMcpActorTokenInput = {
  userId: "user-77",
  orgId: "org-9",
  instanceId: "inst-canonical",
  kind: "wordpress",
  jti: "turn-nonce-1",
  parentJti: "cwu-row-1",
  turnRunId: "run-of-this-turn",
};

const PRIOR_SECRET = process.env.BETTER_AUTH_SECRET;
beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "widget-obo-turn-binding-secret";
});
afterEach(() => {
  vi.useRealTimers();
});
afterAll(() => {
  if (PRIOR_SECRET === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = PRIOR_SECRET;
});

beforeEach(() => {
  readWidgetTokenParentLiveness.mockReset().mockReturnValue("live");
  readAssistantTurnActivityByRunId.mockReset().mockReturnValue("active");
});

/** Present a bearer exactly as the MCP transport does. */
function present(token: string) {
  return {
    authHeader: `Bearer ${token}`,
    request: new Request(PUBLIC_MCP_URL),
    expectedAudience: PUBLIC_MCP_URL,
    expectedIssuer: PUBLIC_AUTH_URL,
  };
}

/** The PRE-#2687 answer for the same bearer: signature + claims only, no store
 *  read at all. Every negative control below asserts this still says yes. */
function rawVerifyStillAccepts(token: string): boolean {
  return verifyWidgetMcpActorToken(present(token)) !== null;
}

describe("a live turn under a live sign-in authorizes, unchanged", () => {
  it("resolves the full widget actor", () => {
    const actor = verifyLiveWidgetMcpActor(present(issueWidgetMcpActorToken(INPUT)));
    expect(actor).toEqual({
      delegation: "public_site_widget",
      userId: "user-77",
      orgId: "org-9",
      instanceId: "inst-canonical",
      kind: "wordpress",
      jti: "turn-nonce-1",
      parentJti: "cwu-row-1",
      turnRunId: "run-of-this-turn",
      platformRole: "member",
      // cinatra#2577 (S8d) — the `lcr` grant claim. This INPUT mints none, so
      // the verifier reads it as NO grant; the authorization layer neither
      // widens nor consults it.
      lifecycleRead: false,
    });
  });

  it("asks each store exactly what the token sealed — the parent row and the turn", () => {
    verifyLiveWidgetMcpActor(present(issueWidgetMcpActorToken(INPUT)));
    expect(readWidgetTokenParentLiveness).toHaveBeenCalledWith("cwu-row-1");
    expect(readAssistantTurnActivityByRunId).toHaveBeenCalledWith("run-of-this-turn");
  });

  it("the TTL and every existing check are untouched — an expired token is still refused", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T01:00:00Z"));
    const token = issueWidgetMcpActorToken(INPUT);
    // Inside the window, with both stores positive: accepted.
    vi.setSystemTime(new Date("2026-08-12T01:01:00Z")); // +60 s
    expect(verifyLiveWidgetMcpActor(present(token))).not.toBeNull();
    // Past 120 s: refused by the ORIGINAL TTL bound, before either store is
    // consulted — the new checks did not replace the old containment.
    vi.setSystemTime(new Date("2026-08-12T01:02:01Z")); // +121 s
    readWidgetTokenParentLiveness.mockClear();
    readAssistantTurnActivityByRunId.mockClear();
    expect(verifyLiveWidgetMcpActor(present(token))).toBeNull();
    expect(readWidgetTokenParentLiveness).not.toHaveBeenCalled();
    expect(readAssistantTurnActivityByRunId).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The transport's own expression. `verifyDelegatedActorToken`'s widget branch is
// exactly one call to this, so what runs at /api/mcp is what is asserted here —
// including the two things that happen on top of the authorization decision.
// ---------------------------------------------------------------------------
describe("the transport-shaped resolver", () => {
  it("normalizes the instance pin and hands the seals to nobody", () => {
    const actor = resolveWidgetDelegatedActorForTransport(
      present(issueWidgetMcpActorToken(INPUT)),
    );
    expect(actor).toEqual({
      delegation: "public_site_widget",
      userId: "user-77",
      orgId: "org-9",
      instanceId: "inst-canonical",
      kind: "wordpress",
      jti: "turn-nonce-1",
      platformRole: "member",
      lifecycleRead: false,
      connectorInstancePin: { connectorKey: "wordpress", instanceId: "inst-canonical" },
    });
    // The seals authorized the call; they are not a capability the frame carries.
    expect(actor).not.toHaveProperty("parentJti");
    expect(actor).not.toHaveProperty("turnRunId");
  });

  it("returns null — never a partial frame — for a completed turn and for a dead parent", () => {
    readAssistantTurnActivityByRunId.mockReturnValue("ended");
    expect(resolveWidgetDelegatedActorForTransport(present(issueWidgetMcpActorToken(INPUT)))).toBeNull();
    readAssistantTurnActivityByRunId.mockReturnValue("active");
    readWidgetTokenParentLiveness.mockReturnValue("dead");
    expect(resolveWidgetDelegatedActorForTransport(present(issueWidgetMcpActorToken(INPUT)))).toBeNull();
  });
});

describe("AC-1/AC-2 — a token presented AFTER ITS TURN COMPLETES is refused", () => {
  it("refuses it, and the raw verifier still accepts the same token (negative control)", () => {
    const token = issueWidgetMcpActorToken(INPUT);
    // The turn's terminal status is committed; the token has not expired.
    readAssistantTurnActivityByRunId.mockReturnValue("ended");

    expect(verifyLiveWidgetMcpActor(present(token))).toBeNull();

    // NEGATIVE CONTROL. This is the pre-#2687 code path — signature, claims,
    // TTL — and it says the token is fine. So the refusal above comes from the
    // turn check and from nothing else: delete that one line and this token is
    // accepted again, which is exactly the state the issue describes.
    expect(rawVerifyStillAccepts(token)).toBe(true);
  });

  it("refuses when the turn cannot be looked up at all (`unknown` refuses like `ended`)", () => {
    const token = issueWidgetMcpActorToken(INPUT);
    readAssistantTurnActivityByRunId.mockReturnValue("unknown");
    expect(verifyLiveWidgetMcpActor(present(token))).toBeNull();
    expect(rawVerifyStillAccepts(token)).toBe(true);
  });

  it("the turn check is reached even when the sign-in is live — it is not a proxy for #2684", () => {
    // A token whose person is still signed in, whose turn is over. Before this
    // change there was nothing in the system that could refuse this.
    const token = issueWidgetMcpActorToken(INPUT);
    readWidgetTokenParentLiveness.mockReturnValue("live");
    readAssistantTurnActivityByRunId.mockReturnValue("ended");
    expect(verifyLiveWidgetMcpActor(present(token))).toBeNull();
    expect(readWidgetTokenParentLiveness).toHaveBeenCalledTimes(1);
  });

  it("a token minted for ANOTHER turn is refused while THIS turn runs", () => {
    // The store is asked about the run the TOKEN names, never about whatever
    // run happens to be current — so a token cannot be carried across turns.
    const other = issueWidgetMcpActorToken({ ...INPUT, turnRunId: "run-somebody-elses" });
    readAssistantTurnActivityByRunId.mockImplementation((runId: unknown) =>
      runId === "run-of-this-turn" ? "active" : "ended",
    );
    expect(verifyLiveWidgetMcpActor(present(other))).toBeNull();
    expect(readAssistantTurnActivityByRunId).toHaveBeenCalledWith("run-somebody-elses");
  });
});

describe("AC-3 — a token presented AFTER SIGN-OUT is refused, through the shared reader", () => {
  it("refuses it, and the raw verifier still accepts the same token (negative control)", () => {
    const token = issueWidgetMcpActorToken(INPUT);
    // The Better Auth session behind the `cwu_` row is gone (#2684's `dead`).
    readWidgetTokenParentLiveness.mockReturnValue("dead");

    expect(verifyLiveWidgetMcpActor(present(token))).toBeNull();
    expect(readWidgetTokenParentLiveness).toHaveBeenCalledWith("cwu-row-1");
    expect(rawVerifyStillAccepts(token)).toBe(true);
  });

  it("refuses on `unknown` too — a store that cannot answer does not authorize", () => {
    const token = issueWidgetMcpActorToken(INPUT);
    readWidgetTokenParentLiveness.mockReturnValue("unknown");
    expect(verifyLiveWidgetMcpActor(present(token))).toBeNull();
  });

  it("a dead parent short-circuits before the turn is read — order is deliberate", () => {
    readWidgetTokenParentLiveness.mockReturnValue("dead");
    expect(verifyLiveWidgetMcpActor(present(issueWidgetMcpActorToken(INPUT)))).toBeNull();
    expect(readAssistantTurnActivityByRunId).not.toHaveBeenCalled();
  });
});

describe("a forged or unsealed token never reaches the database", () => {
  it("refuses a garbage bearer and an absent header without asking either store", () => {
    expect(verifyLiveWidgetMcpActor(present("not.a.token"))).toBeNull();
    expect(
      verifyLiveWidgetMcpActor({
        authHeader: null,
        request: new Request(PUBLIC_MCP_URL),
        expectedAudience: PUBLIC_MCP_URL,
        expectedIssuer: PUBLIC_AUTH_URL,
      }),
    ).toBeNull();
    expect(readWidgetTokenParentLiveness).not.toHaveBeenCalled();
    expect(readAssistantTurnActivityByRunId).not.toHaveBeenCalled();
  });

  it("refuses a token minted before #2687 (it seals nothing) with no store read", () => {
    // Hand-sign the OLD claim set under the live secret: a perfectly valid
    // signature over a payload with no `pjti` and no `run`. It is refused at
    // the claim gate, so a rolling deploy never turns an unsealed token into a
    // store question nobody can answer.
    const iat = Math.floor(Date.now() / 1000);
    const legacy = signClaims({
      t: "cinatra.widget.mcp-obo",
      sub: "user-77",
      org: "org-9",
      inst: "inst-canonical",
      knd: "wordpress",
      src: "public_site_widget",
      jti: "turn-nonce-1",
      scope: "mcp:connect",
      aud: PUBLIC_MCP_URL,
      iss: PUBLIC_AUTH_URL,
      iat,
      exp: iat + 120,
    });
    expect(verifyLiveWidgetMcpActor(present(legacy))).toBeNull();
    expect(readWidgetTokenParentLiveness).not.toHaveBeenCalled();
    expect(readAssistantTurnActivityByRunId).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The drift pin. #2684 exists because four widget credentials each answered
// "is this still authorized?" their own way. This is the fifth, and the whole
// value of the shared predicate is that nobody re-implements it here.
// ---------------------------------------------------------------------------
async function readSource(rel: string): Promise<string> {
  const { readFileSync } = await import("node:fs");
  const path = await import("node:path");
  return readFileSync(path.join(process.cwd(), rel), "utf8");
}

describe("this layer asks the SHARED liveness predicate, not a copy of it", () => {
  it("imports the leaf and defines no session read of its own", async () => {
    const src = await readSource("src/lib/widget-mcp-actor-authorization.ts");
    expect(src).toContain("@/lib/widget-session-binding");
    expect(src).toContain("readWidgetTokenParentLiveness");
    // No SQL, no store client: the questions are asked of the modules that own
    // the tables, so a laxer answer cannot be written here by accident.
    expect(src).not.toMatch(/\bSELECT\b/);
    expect(src).not.toContain("runPostgresQueriesSync");
  });
});

// ---------------------------------------------------------------------------
// AND THE PRODUCTION BOUNDARY MUST ACTUALLY GO THROUGH IT (codex round 0,
// MEDIUM 3). Everything above proves what this layer does. Nothing above proves
// the MCP transport uses it — and `src/lib/mcp-server.ts` is a settings object
// assembled from most of the application, so no test can import it and call the
// callback. Point the raw verifier back at that seam and every assertion in this
// file, in the token suite, in the route suite and in the runtime suite would
// still be green while the whole defect came back. So the wiring is pinned
// structurally, which is the same technique #2684 used for its third reader.
// ---------------------------------------------------------------------------
describe("the MCP transport resolves widget actors through THIS layer", () => {
  it("the delegated-actor callback is EXACTLY the three-verifier chain, widget arm last", async () => {
    const src = await readSource("src/lib/mcp-server.ts");
    const open = "verifyDelegatedActorToken: async (input) => {";
    const start = src.indexOf(open);
    expect(start, "the delegated-actor callback moved or was renamed").toBeGreaterThan(-1);
    const end = src.indexOf("\n  },", start);
    const body = src
      .slice(start + open.length, end)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("//"))
      .join(" ");
    // The WHOLE arm, not a substring of it (codex round 2). Pinning only the
    // presence of the checked call lets a bypass sit in front of it and return
    // first; pinning the body means any extra branch, any second return and any
    // other verifier call fails here.
    expect(body).toBe(
      [
        "const chatActor = await verifyChatMcpActorToken(input);",
        "if (chatActor) return chatActor;",
        "const agentRunActor = await verifyAgentRunMcpActorToken(input);",
        "if (agentRunActor) return agentRunActor;",
        "return resolveWidgetDelegatedActorForTransport(input);",
      ].join(" "),
    );
    expect(src).toContain('from "./widget-mcp-actor-authorization"');
    // The raw verifier skips both store reads. Its name must not appear at the
    // transport seam at all.
    expect(
      src.includes("verifyWidgetMcpActorToken"),
      "the transport must not reach the unchecked verifier",
    ).toBe(false);
  });

  it("the raw verifier has exactly one non-test consumer, and it is this layer", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const path = await import("node:path");
    const roots = [path.join(process.cwd(), "src"), path.join(process.cwd(), "packages")];
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (entry === "__tests__" || entry === "node_modules") continue;
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry) || /\.test\.tsx?$/.test(entry)) continue;
        const rel = path.relative(process.cwd(), full);
        if (rel === "src/lib/widget-mcp-actor-token.ts") continue; // the definition
        if (readFileSync(full, "utf8").includes("verifyWidgetMcpActorToken")) {
          callers.push(rel);
        }
      }
    };
    for (const root of roots) walk(root);
    expect(callers).toEqual(["src/lib/widget-mcp-actor-authorization.ts"]);
  });

  // Codex round 1 built the escape the two assertions above cannot see on their
  // own: re-export the raw verifier under a second name, import THAT at the
  // seam, and every string check still passes. So the EXPORT SURFACES of both
  // modules are pinned — an alias is a name, and a new name fails here.
  it("neither module exports an alias that could smuggle the unchecked verifier out", async () => {
    const exportedValues = (src: string): string[] =>
      [...src.matchAll(/^export (?:async )?(?:function|const|let|class) (\w+)/gm)]
        .map((m) => m[1] as string)
        .sort();

    expect(exportedValues(await readSource("src/lib/widget-mcp-actor-authorization.ts"))).toEqual([
      "resolveWidgetDelegatedActorForTransport",
      "verifyLiveWidgetMcpActor",
    ]);
    expect(exportedValues(await readSource("src/lib/widget-mcp-actor-token.ts"))).toEqual([
      "WIDGET_MCP_TOKEN_TYPE",
      "issueWidgetMcpActorToken",
      "verifyWidgetMcpActorToken",
    ]);
    // And neither `export { … }` nor `export default` in either file — the two
    // forms the regex above cannot read (codex rounds 1 and 2 built a bypass out
    // of each in turn) are simply not allowed here.
    for (const rel of [
      "src/lib/widget-mcp-actor-authorization.ts",
      "src/lib/widget-mcp-actor-token.ts",
    ]) {
      const src = await readSource(rel);
      expect(src.match(/^export \{/m), rel).toBeNull();
      expect(src.match(/^export default\b/m), rel).toBeNull();
    }
  });

  it("the raw verifier is called EXACTLY once in the layer — the one guarded call site", async () => {
    const src = await readSource("src/lib/widget-mcp-actor-authorization.ts");
    // Import + call = two occurrences. A third is an alias, a second call path,
    // or a re-export, and every one of those is a way past the store reads.
    expect(src.split("verifyWidgetMcpActorToken").length - 1).toBe(2);
  });
});

/** Hand-sign arbitrary claims under the live secret (a valid HMAC must not
 *  defeat a fail-closed claim gate). */
function signClaims(claims: Record<string, unknown>): string {
  const header = Buffer.from(
    JSON.stringify({ alg: "HS256", typ: "JWT" }),
    "utf8",
  ).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signingInput = `${header}.${payload}`;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createHmac } = require("node:crypto");
  const signature = createHmac("sha256", process.env.BETTER_AUTH_SECRET!)
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}
