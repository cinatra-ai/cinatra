/**
 * THE WIDGET'S STATED SCHEDULE, MEASURED STAGE BY STAGE (cinatra#3052).
 *
 * A person who states a schedule in the widget's own conversation inside a
 * third-party application was answered "Not available to you." — the ONE fixed
 * sentence `schedule_proposal_render` gives a null proposer, an invalid input, a
 * proposal-service denial, an envelope failure and an exception alike. Because
 * the sentence names nothing, the failing stage was a hypothesis and not a
 * measurement.
 *
 * SO THIS TIER MEASURES IT, on a real database, through the shipped writers:
 *
 *   R1  the consumed widget authorisation's NARROWED SCOPES — the `cwu_` is
 *       issued and redeemed by `issueUserAuthCode` / `redeemUserAuthCode` and
 *       read back by `consumeUserWidgetToken`, never by a hand-written INSERT,
 *       so the scope column is the one a sign-in actually writes;
 *   R2  the constructed `WidgetPrincipal.lifecycleRead`, read off those claims
 *       exactly as the chat route reads them;
 *   R3  the MINTED and VERIFIED delegated actor's grant — `lcr` on the widget
 *       OBO token, resolved back through the transport's own
 *       `resolveWidgetDelegatedActorForTransport` (both seals live: the parent
 *       `cwu_` row and a running turn);
 *   R4  the PARSED TOOL INPUT — what the widget's assistant can actually name;
 *   R5  the PROPOSAL-SERVICE OUTCOME for `schedule_proposal_render`.
 *
 * No credential value is ever recorded: every reading is a boolean, a name, or
 * a set of scope atoms.
 *
 * WHAT THE READINGS SHOW, and it is not what the issue's hypothesis expected:
 * R1, R2 and R3 all carry the grant. The grant is NOT lost. R5 refuses because
 * of R4 — the tool's ONLY agent argument was a `templateId`, and the widget's
 * closed delegated toolbox contains no primitive that can yield one:
 * `agent_list` and `agent_run` are chat-only, and the ONE start the widget holds
 * — `agent_named_start` — deliberately takes a package NAME and refuses ids ("a
 * uuid is not something a person names in a sentence"). So the agent the person
 * named reached the schedule proposal as a name, the template lookup missed, and
 * the generic refusal was the sentence they read.
 *
 * DB-gated, like every other tier here: self-skips without a real
 * SUPABASE_DB_URL — except in the dedicated lane, which refuses to skip.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import { writeConnectorConfigToDatabase } from "@/lib/database";
import { upsertConnectSiteCredential } from "@/lib/connect-sites-store";
import {
  consumeUserWidgetToken,
  createAuthTransaction,
  issueUserAuthCode,
  redeemUserAuthCode,
  resolveVerifiedSiteFromCredential,
  type VerifiedSiteContext,
} from "@/lib/widget-user-auth";
import {
  WIDGET_LIFECYCLE_READ_SCOPE,
  WIDGET_SIGNIN_GRANTED_SCOPES,
  type WidgetExtensionScope,
} from "@/lib/widget-lifecycle-scope";
import { WIDGET_BROKER_ROUTE_PATH } from "@/lib/widget-broker-route";
import { issueWidgetMcpActorToken } from "@/lib/widget-mcp-actor-token";
import { resolveWidgetDelegatedActorForTransport } from "@/lib/widget-mcp-actor-authorization";
import type { WidgetPrincipal } from "@/lib/assistant-runtime/widget-principal";
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server";
import {
  handleScheduleProposalRender,
  SCHEDULE_PROPOSAL_TOOL_META,
} from "../schedule-proposal-mcp";
import {
  LIFECYCLE_PRODUCER_SERVER_LABEL,
  LIFECYCLE_REFUSAL_RESULT,
} from "@/lib/assistant-runtime/lifecycle-view-envelope";
import { createAgUiSinkAdapter } from "@/lib/assistant-runtime/ag-ui-sink-adapter";
import {
  appendAssistantTurn,
  createAssistantThread,
  getAssistantThread,
  reconstructThreadPayload,
  updateAssistantTurn,
} from "@/lib/assistant-thread-store";
import { buildAssistantThreadMirrorQueries } from "@/lib/project-inheritance";
import { getPostgresConnectionString, postgresSchema } from "@/lib/postgres-config";
import { runPostgresQueriesSync } from "@/lib/postgres-sync";
import {
  resolveWidgetLifecycleActorContext,
  WIDGET_LIFECYCLE_DECIDE_GRANT,
} from "@/lib/lifecycle/widget-lifecycle-actor";
import {
  decideTriggerScheduleProposal,
  resolveTriggerScheduleProposalCard,
} from "@/lib/lifecycle/trigger-schedule-proposal-card";
import { X3052_SCHEMA } from "./widget-schedule-grant.setup";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const DB_URL = process.env.SUPABASE_DB_URL ?? "";
const HAS_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const describeDb = HAS_DB ? describe : describe.skip;

const IN_DEDICATED_LANE = process.env.CINATRA_WIDGET_SCHEDULE_GRANT_REALDB === "1";
const ALLOW_SKIP = process.env.X3052_ALLOW_SKIP === "1";

if (IN_DEDICATED_LANE && !ALLOW_SKIP && !HAS_DB) {
  throw new Error(
    "the #3052 widget-schedule-grant lane needs a live Postgres: set SUPABASE_DB_URL " +
      "to a real connection string. Refusing to skip — a skipped measurement of " +
      "which stage refuses measures nothing. Pass X3052_ALLOW_SKIP=1 to skip anyway.",
  );
}

// The tier's OWN schema, from the module that creates and drops it — never from
// the environment, so the suite and its global setup can never name two
// different schemas (see the note there).
const TEST_SCHEMA = X3052_SCHEMA;
const q = (s: string) => s.replaceAll('"', '""');

const ORG_ID = "org-x3052";
const PERSON_ID = "usr-x3052";
const SESSION_ID = "sess-x3052";
const TEMPLATE_ID = "tpl-x3052";
const PACKAGE_NAME = "@cinatra-ai/x3052-agent";
const FOREIGN_ORG_ID = "org-x3052-other";
const FOREIGN_TEMPLATE_ID = "tpl-x3052-other";
const FOREIGN_PACKAGE_NAME = "@cinatra-ai/x3052-foreign-agent";
const SITE_ORIGIN = "https://widget-x3052.example.test";
const INSTANCE_ID = "inst-x3052";
const AGENT_SLUG = "wordpress";

/** The MCP audience/issuer this build mints and verifies against. */
const BASE_URL = (process.env.BETTER_AUTH_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, "");
const MCP_AUDIENCE = `${BASE_URL}/api/mcp`;
const MCP_ISSUER = `${BASE_URL}/api/auth`;

let admin: Client;
let verifiedSite: VerifiedSiteContext | null = null;

/** PKCE, the widget's own way: a verifier and its S256 challenge. */
function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

/**
 * ONE FRESH WIDGET AUTHORISATION, through the shipped writers only.
 *
 * transaction then code (with the grant the sign-in records) then `cwu_`. The
 * scopes are the caller's, so the suite can mint the sign-in this build performs
 * and, for the negative control, one that predates the lifecycle grant — the two
 * sessions the boundary has to tell apart.
 */
function authoriseWidgetSession(grantedScopes: readonly WidgetExtensionScope[]): {
  token: string;
  scope: string;
} {
  const site = verifiedSite;
  if (!site) throw new Error("the connect site did not verify — nothing to authorise against");
  const { verifier, challenge } = pkce();
  const txn = createAuthTransaction({
    site,
    agentSlug: AGENT_SLUG,
    instancesConfigKey: "wordpress",
    codeChallenge: challenge,
    state: randomBytes(16).toString("base64url"),
  });
  if (!txn.ok) throw new Error(`the auth transaction was refused: ${txn.reason}`);
  const issued = issueUserAuthCode({
    txnId: txn.txnId,
    userId: PERSON_ID,
    authSessionId: SESSION_ID,
    grantedScopes,
  });
  if (!issued.ok) throw new Error(`the authorisation code was refused: ${issued.reason}`);
  const redeemed = redeemUserAuthCode({
    code: issued.code,
    codeVerifier: verifier,
    site,
    issuerBaseUrl: BASE_URL,
  });
  if (!redeemed.ok) throw new Error(`the widget user token mint was refused: ${redeemed.reason}`);
  return { token: redeemed.token, scope: redeemed.scope };
}


/**
 * THE PERSON'S MESSAGE, through the shipped legacy-mirror PROJECTION — the same
 * builder `upsertChatThreadInDatabase` composes, in the one transaction it runs
 * it in. It matters that this is the projection and not a hand-written row: the
 * reload reconstructs the transcript from the spine those rows form, and a
 * thread with no spine reconstructs nothing at all (which is the reading, not a
 * defect: a conversation with no message in it is not a conversation).
 */
function persistPersonsMessage(threadId: string, text: string): { id: string } {
  const now = new Date().toISOString();
  const userMessage = { id: `u-${randomUUID()}`, role: "user" as const, content: text };
  runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    transaction: true,
    queries: buildAssistantThreadMirrorQueries({
      schemaName: postgresSchema,
      thread: {
        id: threadId,
        title: text,
        messages: [userMessage],
        createdAt: now,
        updatedAt: now,
        ownerUserId: PERSON_ID,
      },
      explicitMirrorOrgId: ORG_ID,
    }),
  });
  if (!getAssistantThread(threadId)) {
    throw new Error(`the mirror writer did not create thread ${threadId}`);
  }
  return userMessage;
}

/** A running turn for the token's `run` seal — the row the transport reads. */
function openTurn(opts?: { personSaid?: string }): {
  threadId: string;
  runId: string;
  turnId: string;
} {
  const threadId = `thr-x3052-${randomUUID()}`;
  if (opts?.personSaid) {
    // A thread the person actually said something in — the spine a reload reads.
    persistPersonsMessage(threadId, opts.personSaid);
  } else {
    createAssistantThread({ id: threadId, ownerUserId: PERSON_ID, orgId: ORG_ID });
    if (!getAssistantThread(threadId)) {
      throw new Error(`the store did not create thread ${threadId}`);
    }
  }
  const runId = randomUUID();
  const turn = appendAssistantTurn({ threadId, runId, role: "assistant", status: "running" });
  return { threadId, runId, turnId: turn.id };
}

type ChainReadings = {
  r1ConsumedScopes: string[];
  r2PrincipalLifecycleRead: boolean;
  r3ActorLifecycleRead: boolean | null;
  r4ParsedInput: string;
  r5Answer: string;
  cardRef: string | null;
};

/**
 * THE WHOLE CHAIN, ONE READING PER STAGE.
 *
 * Every stage is the SHIPPED expression of itself: the route's own reading of
 * the claims, the runtime's own mint inputs, the transport's own verify. The
 * only thing this helper chooses is what the widget's assistant names.
 */
async function measureChain(input: {
  grantedScopes: readonly WidgetExtensionScope[];
  toolInput: Record<string, unknown>;
}): Promise<ChainReadings> {
  const { token, scope } = authoriseWidgetSession(input.grantedScopes);

  // R1 — the consumed authorisation's narrowed scopes, off the shipped consume.
  const consumed = consumeUserWidgetToken({
    token,
    agentSlug: AGENT_SLUG,
    routePath: WIDGET_BROKER_ROUTE_PATH,
    requestOrigin: SITE_ORIGIN,
  });
  if (!consumed.ok) throw new Error(`the widget token consume was refused: ${consumed.reason}`);
  const r1ConsumedScopes = [...consumed.claims.grantedScopes].sort();
  expect(scope.includes(WIDGET_LIFECYCLE_READ_SCOPE)).toBe(
    input.grantedScopes.includes(WIDGET_LIFECYCLE_READ_SCOPE),
  );

  // R2 — the principal, built the way the chat route builds it.
  const principal: WidgetPrincipal = {
    kind: "public_site_widget",
    userId: consumed.claims.userId,
    orgId: consumed.claims.orgId,
    parentTokenJti: consumed.claims.jti,
    instanceId: consumed.claims.instanceId,
    verifiedOrigin: SITE_ORIGIN,
    assistantHandle: "wordpress",
    instancesConfigKey: "wordpress",
    lifecycleRead:
      Array.isArray(consumed.claims.grantedScopes) &&
      consumed.claims.grantedScopes.includes(WIDGET_LIFECYCLE_READ_SCOPE),
    platformRole: "member",
  };

  // R3 — the delegated actor, minted from that principal and verified back
  // through the transport's own resolver, with both seals live.
  const turn = openTurn();
  const oboToken = issueWidgetMcpActorToken({
    userId: principal.userId,
    orgId: principal.orgId,
    instanceId: principal.instanceId,
    kind: principal.assistantHandle,
    jti: randomUUID(),
    parentJti: principal.parentTokenJti,
    turnRunId: turn.runId,
    lifecycleRead: principal.lifecycleRead,
    platformRole: principal.platformRole,
  });
  const actor = resolveWidgetDelegatedActorForTransport({
    authHeader: `Bearer ${oboToken}`,
    request: new Request(MCP_AUDIENCE, { method: "POST" }),
    expectedAudience: MCP_AUDIENCE,
    expectedIssuer: MCP_ISSUER,
  });
  const r3ActorLifecycleRead = actor ? actor.lifecycleRead : null;

  // R4/R5 — the tool, called on the frame the transport would have built. The
  // reading is taken from the SHIPPED tool schema (the one the MCP registration
  // publishes), not from a re-description of the input: what the widget's
  // assistant can name is exactly what that schema accepts.
  const parsedByTool = SCHEDULE_PROPOSAL_TOOL_META.inputSchema.safeParse(input.toolInput);
  const r4ParsedInput = parsedByTool.success
    ? Object.keys(parsedByTool.data).sort().join(",")
    : "(rejected by the tool schema)";
  const result = await mcpRequestContextStorage.run(
    {
      userId: actor?.userId ?? null,
      orgId: actor?.orgId ?? null,
      delegatedActor: actor ?? null,
    } as never,
    async () => handleScheduleProposalRender(input.toolInput),
  );
  const r5Answer = result.content[0].text;
  const cardRef =
    r5Answer === LIFECYCLE_REFUSAL_RESULT
      ? null
      : ((JSON.parse(r5Answer) as { ref?: string }).ref ?? null);

  // The record. No credential value: booleans, names and scope atoms only.
  console.info(
    `[x3052] R1 consumed scopes=${r1ConsumedScopes.join("|") || "(none)"} ` +
      `R2 principal.lifecycleRead=${principal.lifecycleRead} ` +
      `R3 actor.lifecycleRead=${String(r3ActorLifecycleRead)} ` +
      `R4 input keys=${r4ParsedInput} ` +
      `R5 answer=${r5Answer === LIFECYCLE_REFUSAL_RESULT ? "refused" : "card"}`,
  );

  return {
    r1ConsumedScopes,
    r2PrincipalLifecycleRead: principal.lifecycleRead,
    r3ActorLifecycleRead,
    r4ParsedInput,
    r5Answer,
    cardRef,
  };
}


/**
 * THE ONE STAGE THIS TIER REPLICATES RATHER THAN DRIVES, and the tripwire that
 * keeps the replication honest.
 *
 * R2 is the chat route's own construction of `WidgetPrincipal.lifecycleRead`.
 * Driving the ROUTE would need a live application — a real widget sign-in in a
 * browser, the CMS backend's redeem, a provider turn — which no offline tier
 * has; so the reading above is taken by evaluating the route's OWN expression
 * against the claims the shipped consume returned. That is a replication, and a
 * replication silently rots the day the route changes.
 *
 * So this test reads the route's source and requires the expression to still be
 * there. The same idiom, for the same reason, as the durable-reload tier's
 * "the shipped writer still runs the mirror this tier drives".
 */
const CHAT_ROUTE = "src/app/api/assistants/chat/route.ts";

describe("the stage this tier replicates is still the stage the route runs", () => {
  it("the chat route still builds lifecycleRead from the consumed claims' granted scopes", () => {
    const source = readFileSync(path.join(process.cwd(), CHAT_ROUTE), "utf8");
    const normalised = source.replace(/\s+/g, " ");
    expect(
      normalised,
      `${CHAT_ROUTE} no longer reads the lifecycle grant the way this tier replicates it — ` +
        "the measurement above is about a construction that has moved, so it must move with it",
    ).toContain(
      "lifecycleRead: Array.isArray(claims.grantedScopes) && claims.grantedScopes.includes(WIDGET_LIFECYCLE_READ_SCOPE)",
    );
  });
});

describeDb("the widget's stated schedule, from the authorisation to the card", () => {
  beforeAll(async () => {
    // The schema and the public floor are the global setup's — they have to
    // exist before this module is imported at all, because the widget graph
    // reads the auth tables the moment it loads.
    // THE WORKER IS ON THE THROWAWAY SCHEMA, asserted before anything is
    // written: the store reads `postgresSchema` at import from the config's
    // `test.env`, and a job that exports its own would otherwise have this
    // suite seeding rows into a schema it does not own.
    expect(
      postgresSchema,
      "this suite writes through the shipped stores — it must be pointed at its own throwaway schema",
    ).toBe(TEST_SCHEMA);
    admin = new Client({ connectionString: DB_URL });
    await admin.connect();
    await admin.query(
      `INSERT INTO public."user" (id, username, name, email, "emailVerified")
       VALUES ($1, $2, $3, $4, false) ON CONFLICT (id) DO NOTHING`,
      [PERSON_ID, "x3052", "x3052", "x3052@example.test"],
    );
    await admin.query(
      `INSERT INTO public."organization" (id, slug, name, "createdAt")
       VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
      [ORG_ID, "x3052", "x3052"],
    );
    // A SECOND, REAL ORGANIZATION — the boundary arm below asks what a name
    // discloses about somebody else's org, so that org has to exist.
    await admin.query(
      `INSERT INTO public."organization" (id, slug, name, "createdAt")
       VALUES ($1, $2, $3, now()) ON CONFLICT (id) DO NOTHING`,
      [FOREIGN_ORG_ID, "x3052-other", "x3052-other"],
    );
    await admin.query(
      `INSERT INTO public."member" (id, "organizationId", "userId", "createdAt", role)
       VALUES ($1, $2, $3, now(), $4) ON CONFLICT (id) DO NOTHING`,
      ["mem-x3052", ORG_ID, PERSON_ID, "member"],
    );
    // THE SIGN-IN ITSELF. The authorisation names it and every later read asks
    // whether it is still there; without a live row the flow refuses, which is
    // the shipped revocation rule working.
    await admin.query(
      `INSERT INTO public."session" (id, "userId", token, "expiresAt", "createdAt", "updatedAt", "activeOrganizationId")
       VALUES ($1, $2, $3, now() + interval '1 day', now(), now(), $4) ON CONFLICT (id) DO NOTHING`,
      [SESSION_ID, PERSON_ID, `tok-${SESSION_ID}`, ORG_ID],
    );
    // The agent the person names. It carries a PACKAGE NAME because that is the
    // only handle a widget conversation ever has for it.
    await admin.query(
      `INSERT INTO "${q(TEST_SCHEMA)}"."agent_templates"
         (id, name, package_name, source_nl, compiled_plan, input_schema, approval_policy, org_id, owner_level, owner_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (id) DO NOTHING`,
      [
        TEMPLATE_ID,
        "x3052 agent",
        PACKAGE_NAME,
        "schedule the named agent",
        JSON.stringify({ steps: [] }),
        JSON.stringify({ type: "object", properties: {} }),
        JSON.stringify({ mode: "manual" }),
        ORG_ID,
        "organization",
        ORG_ID,
        "active",
      ],
    );
    // The instance the widget's origin pins to, written through the shipped
    // connector-config writer — the transaction's canonical instance read.
    writeConnectorConfigToDatabase("wordpress", {
      instances: [{ id: INSTANCE_ID, siteUrl: SITE_ORIGIN, name: "x3052" }],
    });
    // The connect site, through its own shipped writer, and then VERIFIED the
    // way the init route verifies it: the context this suite authorises against
    // is the one the shipped credential validator returns, never a hand-built
    // object.
    const secret = randomBytes(24).toString("base64url");
    const siteRow = upsertConnectSiteCredential({
      candidateSiteId: randomUUID(),
      client: "wordpress",
      widgetOrigin: SITE_ORIGIN,
      callbackOrigin: null,
      credentialSecret: secret,
      webhookSecretHash: null,
      adminUserId: PERSON_ID,
      orgId: ORG_ID,
    });
    verifiedSite = resolveVerifiedSiteFromCredential({
      credential: `cnx_${siteRow.siteId}_${secret}`,
      requestOrigin: SITE_ORIGIN,
      expectedClient: "wordpress",
    });
    expect(verifiedSite, "the shipped credential verifier refused the seeded site").not.toBeNull();
  }, 300_000);

  afterAll(async () => {
    if (!admin) return;
    await admin.query(`DELETE FROM public."session" WHERE id = $1`, [SESSION_ID]);
    await admin.query(`DELETE FROM public."member" WHERE id = $1`, ["mem-x3052"]);
    await admin.query(`DELETE FROM public."user" WHERE id = $1`, [PERSON_ID]);
    await admin.query(`DELETE FROM public."organization" WHERE id = ANY($1)`, [
      [ORG_ID, FOREIGN_ORG_ID],
    ]);
    await admin.end();
  }, 120_000);

  // ---------------------------------------------------------------------------
  // ACCEPTANCE 1 — the failing stage, measured.
  // ---------------------------------------------------------------------------

  it("the grant reaches the handler intact — R1, R2 and R3 all carry it", async () => {
    const measured = await measureChain({
      grantedScopes: WIDGET_SIGNIN_GRANTED_SCOPES,
      toolInput: { templateId: TEMPLATE_ID, schedule: { kind: "immediate" } },
    });
    // R1 — the sign-in's own grant survived the code-to-token hop and the consume.
    expect(measured.r1ConsumedScopes).toContain(WIDGET_LIFECYCLE_READ_SCOPE);
    // R2 — the route's reading of those claims.
    expect(measured.r2PrincipalLifecycleRead).toBe(true);
    // R3 — the minted grant claim, read back by the transport's own verifier.
    expect(measured.r3ActorLifecycleRead).toBe(true);
    // R5 — with a template id the chain answers with a card. NO LINK LOSES THE
    // GRANT: the issue's hypothesis is measured and refuted here.
    expect(measured.r5Answer).not.toBe(LIFECYCLE_REFUSAL_RESULT);
    expect(measured.cardRef).toBeTruthy();
  }, 180_000);

  it("the stage that refuses is the AGENT ARGUMENT: the name the widget has is not an id", async () => {
    // THE MEASUREMENT THAT NAMES THE DEFECT. Everything above is unchanged — the
    // same authorisation, the same principal, the same verified grant — and the
    // only difference is the handle the widget's assistant can actually hold for
    // an agent. The ONE start on the widget's closed allowlist takes a package
    // name and refuses ids; the two primitives that yield a template id are
    // chat-only. So this is the call the person's sentence produces inside a
    // third-party application, and its answer was the sentence they were shown.
    const measured = await measureChain({
      grantedScopes: WIDGET_SIGNIN_GRANTED_SCOPES,
      toolInput: { packageName: PACKAGE_NAME, schedule: { kind: "immediate" } },
    });
    expect(measured.r2PrincipalLifecycleRead).toBe(true);
    expect(measured.r3ActorLifecycleRead).toBe(true);
    // The card the person asked for, from the name they gave.
    expect(measured.r5Answer).not.toBe(LIFECYCLE_REFUSAL_RESULT);
    expect(measured.cardRef).toBeTruthy();
  }, 180_000);

  it("a name that names no installed agent is still the one fixed sentence", async () => {
    const measured = await measureChain({
      grantedScopes: WIDGET_SIGNIN_GRANTED_SCOPES,
      toolInput: {
        packageName: "@cinatra-ai/not-installed-x3052",
        schedule: { kind: "immediate" },
      },
    });
    expect(measured.r5Answer).toBe(LIFECYCLE_REFUSAL_RESULT);
  }, 180_000);

  it("naming BOTH an id and a package is refused — one subject per proposal", async () => {
    const measured = await measureChain({
      grantedScopes: WIDGET_SIGNIN_GRANTED_SCOPES,
      toolInput: {
        templateId: TEMPLATE_ID,
        packageName: PACKAGE_NAME,
        schedule: { kind: "immediate" },
      },
    });
    expect(measured.r5Answer).toBe(LIFECYCLE_REFUSAL_RESULT);
  }, 180_000);


  it("a package installed in ANOTHER organization is refused — the org boundary holds by name too", async () => {
    // The name is guessable; the boundary is not. A template whose org is not
    // the reader's answers the same fixed sentence a template that does not
    // exist does, so the name discloses nothing about somebody else's org.
    await admin.query(
      `INSERT INTO "${q(TEST_SCHEMA)}"."agent_templates"
         (id, name, package_name, source_nl, compiled_plan, input_schema, approval_policy, org_id, owner_level, owner_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (id) DO NOTHING`,
      [
        FOREIGN_TEMPLATE_ID,
        "x3052 foreign agent",
        FOREIGN_PACKAGE_NAME,
        "an agent belonging to another organization",
        JSON.stringify({ steps: [] }),
        JSON.stringify({ type: "object", properties: {} }),
        JSON.stringify({ mode: "manual" }),
        FOREIGN_ORG_ID,
        "organization",
        FOREIGN_ORG_ID,
        "active",
      ],
    );
    const byName = await measureChain({
      grantedScopes: WIDGET_SIGNIN_GRANTED_SCOPES,
      toolInput: { packageName: FOREIGN_PACKAGE_NAME, schedule: { kind: "immediate" } },
    });
    expect(byName.r5Answer).toBe(LIFECYCLE_REFUSAL_RESULT);
    // And by ID, unchanged — the two doors refuse the same thing.
    const byId = await measureChain({
      grantedScopes: WIDGET_SIGNIN_GRANTED_SCOPES,
      toolInput: { templateId: FOREIGN_TEMPLATE_ID, schedule: { kind: "immediate" } },
    });
    expect(byId.r5Answer).toBe(LIFECYCLE_REFUSAL_RESULT);
  }, 240_000);

  it("a third-party scope is NOT collapsed to the canonical one", async () => {
    // `agent_run`'s alias bridges the operator's OWN namespace to the canonical
    // scope and nothing else. A foreign vendor scope naming an installed slug
    // must not resolve, or the alias would make any scope mean any other.
    const measured = await measureChain({
      grantedScopes: WIDGET_SIGNIN_GRANTED_SCOPES,
      toolInput: { packageName: "@somevendor/x3052-agent", schedule: { kind: "immediate" } },
    });
    expect(measured.r5Answer).toBe(LIFECYCLE_REFUSAL_RESULT);
  }, 180_000);

  // ---------------------------------------------------------------------------
  // ACCEPTANCE 2 — the boundary the producer-level test cannot reach.
  // ---------------------------------------------------------------------------

  it("consumed scope, principal, verified actor, the real handler: granted draws, ungranted refuses", async () => {
    const granted = await measureChain({
      grantedScopes: WIDGET_SIGNIN_GRANTED_SCOPES,
      toolInput: { packageName: PACKAGE_NAME, schedule: { kind: "immediate" } },
    });
    expect(granted.r1ConsumedScopes).toContain(WIDGET_LIFECYCLE_READ_SCOPE);
    expect(granted.r3ActorLifecycleRead).toBe(true);
    expect(granted.r5Answer).not.toBe(LIFECYCLE_REFUSAL_RESULT);

    // A SESSION WHOSE SIGN-IN PREDATES THE GRANT. Same person, same site, same
    // agent, same sentence — the only difference is the scope the authorisation
    // recorded, and it is recorded by the shipped writer rather than edited in.
    const withheld = WIDGET_SIGNIN_GRANTED_SCOPES.filter(
      (s) => s !== WIDGET_LIFECYCLE_READ_SCOPE,
    );
    const ungranted = await measureChain({
      grantedScopes: withheld,
      toolInput: { packageName: PACKAGE_NAME, schedule: { kind: "immediate" } },
    });
    expect(ungranted.r1ConsumedScopes).not.toContain(WIDGET_LIFECYCLE_READ_SCOPE);
    expect(ungranted.r2PrincipalLifecycleRead).toBe(false);
    expect(ungranted.r3ActorLifecycleRead).toBe(false);
    expect(ungranted.r5Answer).toBe(LIFECYCLE_REFUSAL_RESULT);
  }, 240_000);

  // ---------------------------------------------------------------------------
  // ACCEPTANCE 3 — one persisted widget thread, end to end.
  // ---------------------------------------------------------------------------

  it("stated, held, reloaded, confirmed, one run, settled — on one thread", async () => {
    // 1. THE PERSON STATES A SCHEDULE, on a real widget frame.
    const { token } = authoriseWidgetSession(WIDGET_SIGNIN_GRANTED_SCOPES);
    const consumed = consumeUserWidgetToken({
      token,
      agentSlug: AGENT_SLUG,
      routePath: WIDGET_BROKER_ROUTE_PATH,
      requestOrigin: SITE_ORIGIN,
    });
    if (!consumed.ok) throw new Error(`the widget token consume was refused: ${consumed.reason}`);
    const turn = openTurn({ personSaid: "run the x3052 agent every Monday at 09:00" });
    const oboToken = issueWidgetMcpActorToken({
      userId: consumed.claims.userId,
      orgId: consumed.claims.orgId,
      instanceId: consumed.claims.instanceId,
      kind: "wordpress",
      jti: randomUUID(),
      parentJti: consumed.claims.jti,
      turnRunId: turn.runId,
      lifecycleRead: consumed.claims.grantedScopes.includes(WIDGET_LIFECYCLE_READ_SCOPE),
      platformRole: "member",
    });
    const actor = resolveWidgetDelegatedActorForTransport({
      authHeader: `Bearer ${oboToken}`,
      request: new Request(MCP_AUDIENCE, { method: "POST" }),
      expectedAudience: MCP_AUDIENCE,
      expectedIssuer: MCP_ISSUER,
    });
    expect(actor, "the transport refused the widget token").not.toBeNull();

    const runAt = new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString().slice(0, 16);
    const answer = await mcpRequestContextStorage.run(
      {
        userId: actor?.userId ?? null,
        orgId: actor?.orgId ?? null,
        delegatedActor: actor ?? null,
      } as never,
      async () =>
        handleScheduleProposalRender({
          packageName: PACKAGE_NAME,
          schedule: { kind: "scheduled", runAt, timezone: "Europe/Berlin" },
        }),
    );
    expect(answer.content[0].text).not.toBe(LIFECYCLE_REFUSAL_RESULT);
    const ref = (JSON.parse(answer.content[0].text) as { ref: string }).ref;

    // 2. THE TURN IS PERSISTED THE WAY THE STREAM ROUTE PERSISTS IT — the real
    //    sink, the real store. Nothing here writes render state by hand.
    const toolCallId = `call-${randomUUID()}`;
    const sink = createAgUiSinkAdapter({
      runId: turn.runId,
      threadId: turn.threadId,
      publish: async () => undefined,
    });
    sink.start();
    sink.send("text", { content: "Here is the schedule you stated." });
    sink.send("tool_call", {
      id: toolCallId,
      name: "schedule_proposal_render",
      serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
    });
    sink.send("tool_result", {
      id: toolCallId,
      name: "schedule_proposal_render",
      serverLabel: LIFECYCLE_PRODUCER_SERVER_LABEL,
      resultLabel: "schedule_proposal_render ok",
      result: answer.content[0].text,
    });
    sink.send("done", {});
    await sink.drain();
    const durable = sink.durableContent();
    expect(durable, "the sink kept nothing durable for the turn").not.toBeNull();
    updateAssistantTurn(turn.turnId, { status: "completed", content: durable });

    // 3. THE RELOAD. Postgres alone — no Redis, no client memory — and the
    //    pending card comes back at the step that produced it.
    const reloaded = reconstructThreadPayload(turn.threadId);
    expect(reloaded, "the reload reconstructed no payload at all").not.toBeNull();
    const messages = (reloaded as { messages?: unknown }).messages as Array<
      Record<string, unknown>
    >;
    const assistant = messages.find((m) => m.role === "assistant");
    expect(assistant, "the reload brought back no assistant turn").toBeTruthy();
    const parts = (assistant?.parts ?? []) as Array<Record<string, unknown>>;
    const producing = parts.find((p) => p.id === toolCallId);
    expect(producing, "the producing step did not come back").toBeTruthy();
    expect(producing?.views).toEqual([
      { viewType: "trigger_schedule_proposal", schemaVersion: 1, ref },
    ]);

    // 4. THE CARD IS PENDING, read under the WIDGET's own credential — the same
    //    actor the decide route resolves, from the same token, with no cookie.
    const widgetActor = await resolveWidgetLifecycleActorContext({
      token,
      agentSlug: AGENT_SLUG,
      requestOrigin: SITE_ORIGIN,
      grant: WIDGET_LIFECYCLE_DECIDE_GRANT,
    });
    expect(widgetActor.ok, "the widget credential did not resolve a deciding actor").toBe(true);
    if (!widgetActor.ok) return;
    const pending = await resolveTriggerScheduleProposalCard({
      ref,
      userId: widgetActor.actorCtx.actor.userId ?? "",
      orgId: widgetActor.actorCtx.orgId,
      access: { actor: widgetActor.actorCtx.actor, roles: widgetActor.actorCtx.roleHints },
    });
    // The card state is the lifecycle envelope's own shape, read off its `state`.
    expect(pending.state.state).toBe("pending");
    expect(pending.view, "a pending card with no body draws nothing").toBeTruthy();

    // 5. CONFIRM, under that same widget credential.
    const outcome = await decideTriggerScheduleProposal({
      ref,
      op: "confirm",
      userId: widgetActor.actorCtx.actor.userId ?? "",
      orgId: widgetActor.actorCtx.orgId,
      role: null,
      access: { actor: widgetActor.actorCtx.actor, roles: widgetActor.actorCtx.roleHints },
    });
    expect(outcome.kind, JSON.stringify(outcome)).toBe("confirmed");
    const confirmedRunId = (outcome as { runId: string }).runId;

    // 6. THE ROWS. One consume, one run, one trigger — read back off the store.
    const consumes = await admin.query(
      `SELECT run_id FROM "${q(TEST_SCHEMA)}"."trigger_schedule_proposal_consumes" WHERE run_id = $1`,
      [confirmedRunId],
    );
    expect(consumes.rows).toHaveLength(1);
    const runs = await admin.query(
      `SELECT id, run_by, org_id FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE id = $1`,
      [confirmedRunId],
    );
    expect(runs.rows).toHaveLength(1);
    expect(runs.rows[0].run_by).toBe(PERSON_ID);
    expect(runs.rows[0].org_id).toBe(ORG_ID);
    const allRuns = await admin.query(
      `SELECT count(*)::int AS n FROM "${q(TEST_SCHEMA)}"."agent_runs" WHERE template_id = $1`,
      [TEMPLATE_ID],
    );
    expect(allRuns.rows[0].n, "confirm created more than one run").toBe(1);
    const triggers = await admin.query(
      `SELECT count(*)::int AS n, max(trigger_type) AS kind, max(timezone) AS tz FROM "${q(TEST_SCHEMA)}"."agent_run_triggers" WHERE run_id = $1`,
      [confirmedRunId],
    );
    expect(triggers.rows[0].n, "the confirmed schedule armed no trigger row").toBe(1);
    // The row says what the person confirmed, not what the model said.
    expect(triggers.rows[0].kind).toBe("scheduled");
    expect(triggers.rows[0].tz).toBe("Europe/Berlin");

    // 7. THE SECOND RELOAD resolves the SAME transcript reference as settled.
    const settled = await resolveTriggerScheduleProposalCard({
      ref,
      userId: widgetActor.actorCtx.actor.userId ?? "",
      orgId: widgetActor.actorCtx.orgId,
      access: { actor: widgetActor.actorCtx.actor, roles: widgetActor.actorCtx.roleHints },
    });
    expect(settled.state.state).not.toBe("pending");
    const reloadedAgain = reconstructThreadPayload(turn.threadId);
    const messagesAgain = (reloadedAgain as { messages?: unknown }).messages as Array<
      Record<string, unknown>
    >;
    const assistantAgain = messagesAgain.find((m) => m.role === "assistant");
    const partsAgain = (assistantAgain?.parts ?? []) as Array<Record<string, unknown>>;
    expect(partsAgain.find((p) => p.id === toolCallId)?.views).toEqual([
      { viewType: "trigger_schedule_proposal", schemaVersion: 1, ref },
    ]);
  }, 300_000);
});
