/**
 * Track A/B fixture prerequisite seeding.
 *
 * Email + auditor + list-curator + reviewer-agent agents need pre-existing
 * Cinatra objects to run end-to-end (campaign context, draft bundles,
 * recipient lists, etc.) AND require pre-filled `inputParams` because
 * their StartNode declares fields as `cinatra.required + cinatra.hidden`.
 * Hidden+required fields are skipped by the setup-loop (execution.ts:826
 * `x-hidden` guard), so the empty-`/new` redirect can't surface them as
 * HITL gates — the run must be created with the inputs pre-filled.
 *
 * Design choice: direct DB insert + BullMQ enqueue, NOT a
 * /new?inputs=... route variant. Reasoning:
 *   - The seeder is test-only — bypassing the production /new path is
 *     acceptable because the production path's only purpose is collecting
 *     the same inputs interactively.
 *   - No server-action signature change → no surface area exposed in
 *     production code.
 *   - The seed module owns the run row's ID so it can wire it into
 *     downstream object seeds (`cinatra_agent_run_id` references).
 *
 * Idempotency: each helper uses ON CONFLICT (id) DO UPDATE for objects.
 * Agent runs use fresh UUIDs per call (each test wants a clean run).
 */
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { Queue } from "bullmq";

const DATABASE_URL =
  process.env.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5434/postgres";
const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
const REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const QUEUE_NAME = process.env.BULLMQ_QUEUE_NAME ?? "cinatra-background-jobs";
const AGENT_BUILDER_EXECUTION = "agent-builder-execution";

async function withPg<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({
    connectionString: DATABASE_URL,
    connectionTimeoutMillis: 5_000,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

async function resolveTestActor(): Promise<{ userId: string; orgId: string }> {
  return withPg(async (c) => {
    const u = await c.query<{ id: string }>(
      `SELECT id FROM public."user" WHERE email = 'agents-run-uat@local.test' LIMIT 1`,
    );
    if (u.rowCount === 0) {
      throw new Error("seed.ts: test user not found — run auth.setup.ts");
    }
    const userId = u.rows[0].id;
    // Use the SESSION's activeOrganizationId, not the first membership.
    // The test user belongs to multiple orgs ("Agents Run UAT Org" +
    // "Default"); the UI session is anchored to the *active* org
    // ("Default", a UUID) and every agent run + objects row is scoped to
    // it. A `member ORDER BY createdAt ASC LIMIT 1` would pick the
    // FIRST-created org instead, so seeded `cinatra.objects` rows would
    // land in the wrong org and the list-picker / campaign-context lookups
    // (which scope by the session's active org) would never find them.
    const s = await c.query<{ id: string }>(
      `SELECT "activeOrganizationId" AS id
       FROM public."session"
       WHERE "userId" = $1 AND "activeOrganizationId" IS NOT NULL
       ORDER BY "updatedAt" DESC LIMIT 1`,
      [userId],
    );
    if (s.rowCount && s.rows[0].id) {
      return { userId, orgId: s.rows[0].id };
    }
    // Fallback: no active session row yet (seed ran before auth.setup
    // persisted a session). Use the most-recently-joined membership —
    // closer to "active" than the oldest one.
    const o = await c.query<{ id: string }>(
      `SELECT m."organizationId" AS id
       FROM public."member" m
       WHERE m."userId" = $1
       ORDER BY m."createdAt" DESC LIMIT 1`,
      [userId],
    );
    if (o.rowCount === 0) {
      throw new Error(`seed.ts: user ${userId} has no organization`);
    }
    return { userId, orgId: o.rows[0].id };
  });
}

/**
 * Deterministic seed IDs — fixtures reference them so hitlScreens actions
 * can be authored statically. Idempotent via ON CONFLICT.
 */
export const SEED_IDS = {
  campaignContextA: "00000000-0000-0000-0000-000000000001",
  contactListA: "00000000-0000-0000-0000-000000000002",
  draftBundleA: "00000000-0000-0000-0000-000000000003",
  followupBundleA: "00000000-0000-0000-0000-000000000004",
  approvedDraftBundleA: "00000000-0000-0000-0000-000000000005",
  confirmedRecipientsA: "00000000-0000-0000-0000-000000000006",
} as const;

/**
 * Insert (or upsert) a `@cinatra-ai/campaigns:context` row. Returns the row id.
 * Set `cinatra_agent_run_id` to the future agent run id when the agent
 * looks up the context by run id (most email agents).
 */
export async function seedCampaignContext(
  id: string = SEED_IDS.campaignContextA,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const { userId, orgId } = await resolveTestActor();
  const data = {
    name: "UAT Outreach — Example",
    website: "https://example.com",
    senderName: "UAT Sender",
    senderEmail: "agents-run-uat@local.test",
    callToAction: "Book a demo: https://example.com/calendar",
    offeringCompanyWebsite: "https://example.com",
    ...overrides,
  };
  await withPg((c) =>
    c.query(
      // ON CONFLICT also corrects org_id + created_by, so a seed run that
      // wrote these rows under the wrong org is repaired; a data-only
      // upsert would leave a stale org_id in place forever.
      // Set the full ownership tuple. Without explicit
      // visibility='organization', the column defaults to empty/null and
      // the objects MCP filters out the row (visibility predicate
      // requires a known scope). owner_level + owner_id are set
      // identically to how a real `objects_save` would write them.
      `INSERT INTO ${SCHEMA}.objects (id, type, data, created_by, org_id, source, owner_level, owner_id, visibility)
       VALUES ($1, '@cinatra-ai/campaigns:context', $2::jsonb, $3, $4, 'uat-seed', 'organization', $4, 'organization')
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data,
         org_id = EXCLUDED.org_id, created_by = EXCLUDED.created_by,
         owner_level = EXCLUDED.owner_level, owner_id = EXCLUDED.owner_id,
         visibility = EXCLUDED.visibility,
         updated_at = now()`,
      [id, JSON.stringify(data), userId, orgId],
    ),
  );
  return id;
}

/**
 * Create a fresh agent run row with pre-filled `inputParams` and enqueue
 * the BullMQ execution job. Returns the new run id.
 *
 * Bypasses `/agents/<v>/<s>/new` because that route hardcodes empty
 * inputParams. Test-only path; production runs go through the route.
 */
export async function seedAgentRun(
  packageName: string,
  inputParams: Record<string, unknown>,
): Promise<string> {
  const { userId, orgId } = await resolveTestActor();
  const runId = randomUUID();
  const { templateId, packageVersion } = await withPg(async (c) => {
    const r = await c.query<{ id: string; package_version: string | null }>(
      `SELECT id, package_version FROM ${SCHEMA}.agent_templates
       WHERE package_name = $1 LIMIT 1`,
      [packageName],
    );
    if (r.rowCount === 0) {
      throw new Error(`seed.ts: agent_templates row for ${packageName} not found`);
    }
    return { templateId: r.rows[0].id, packageVersion: r.rows[0].package_version };
  });
  await withPg((c) =>
    c.query(
      `INSERT INTO ${SCHEMA}.agent_runs
         (id, template_id, run_by, status, input_params, source_type,
          package_version, ag_ui_enabled, org_id)
       VALUES ($1, $2, $3, 'queued', $4, 'agent_builder', $5, true, $6)`,
      [runId, templateId, userId, JSON.stringify(inputParams), packageVersion, orgId],
    ),
  );
  // Enqueue the execution job. Use the same shape as run-actions.ts:94 —
  // jobId === runId for idempotency, name === AGENT_BUILDER_EXECUTION.
  const queue = new Queue(QUEUE_NAME, { connection: { url: REDIS_URL } });
  try {
    await queue.add(
      AGENT_BUILDER_EXECUTION,
      {
        runId,
        __actorContext: {
          principalType: "HumanUser",
          principalId: userId,
          organizationId: orgId,
          platformRole: "platform_admin",
          orgRole: "member",
          authSource: "ui",
          policyVersion: "v2",
        },
      },
      { jobId: runId, removeOnComplete: 200, removeOnFail: 500, attempts: 1 },
    );
  } finally {
    await queue.close();
  }
  return runId;
}

/**
 * Upsert a `@cinatra-ai/lists:list` row so the email-recipient-selection
 * agent's `@cinatra/email-outreach-agent:list-picker` HITL gate has a
 * list to pick. The shape mirrors a real lists object (see
 * `cinatra.objects` rows of this type): name, memberType, membership.
 *
 * `memberRefs` references the test user's seeded contacts; an empty
 * array is acceptable for the picker (it shows the list with
 * memberCount 0) but the recipient-selection agent's downstream
 * recipients-generate step expects at least one member, so seed one
 * placeholder contact ref by default.
 */
/**
 * Seed a `@cinatra-ai/dynamic:email-drafts-bundle` row.
 * The reviewer-agent's review step looks up the bundle by id via
 * `objects_get` and iterates the `drafts[]` array (one entry per
 * recipient). One canonical draft is enough to drive the LLM review.
 */
export async function seedDraftBundle(
  id: string = SEED_IDS.draftBundleA,
): Promise<string> {
  const { userId, orgId } = await resolveTestActor();
  const data = {
    drafts: [
      {
        contactId: "00000000-0000-0000-0000-00000000abcd",
        subject: "Quick thought on your outreach pipeline",
        body:
          "Hi Pat,\n\nNoticed Example Co is hiring four BDR roles in Q3 — " +
          "that usually means manual outreach is eating someone's week. " +
          "We help teams in your spot cut that overhead by ~70%. Worth " +
          "a 15-min look?\n\nBest,\nUAT Sender",
      },
    ],
  };
  await withPg((c) =>
    c.query(
      `INSERT INTO ${SCHEMA}.objects (id, type, data, created_by, org_id, source, owner_level, owner_id, visibility)
       VALUES ($1, '@cinatra-ai/dynamic:email-drafts-bundle', $2::jsonb, $3, $4, 'uat-seed', 'organization', $4, 'organization')
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data,
         org_id = EXCLUDED.org_id, created_by = EXCLUDED.created_by,
         owner_level = EXCLUDED.owner_level, owner_id = EXCLUDED.owner_id,
         visibility = EXCLUDED.visibility,
         updated_at = now()`,
      [id, JSON.stringify(data), userId, orgId],
    ),
  );
  return id;
}

/**
 * Seed a `@cinatra-ai/dynamic:email-followup-bundle` row.
 * Same shape as the draft bundle but represents the follow-up sequence
 * for each recipient.
 */
export async function seedFollowupBundle(
  id: string = SEED_IDS.followupBundleA,
): Promise<string> {
  const { userId, orgId } = await resolveTestActor();
  const data = {
    sequence: [
      {
        contactId: "00000000-0000-0000-0000-00000000abcd",
        steps: [
          {
            dayOffset: 3,
            subject: "Following up — quick read",
            body:
              "Hi Pat,\n\nCircling back on my note from earlier. Happy to " +
              "share a 2-minute walkthrough if useful.\n\nBest,\nUAT Sender",
          },
          {
            dayOffset: 7,
            subject: "One more — last check-in",
            body:
              "Hi Pat,\n\nLast touch — no worries if the timing's off. " +
              "Wish you the best with the Q3 rollout.\n\nBest,\nUAT Sender",
          },
        ],
      },
    ],
  };
  await withPg((c) =>
    c.query(
      `INSERT INTO ${SCHEMA}.objects (id, type, data, created_by, org_id, source, owner_level, owner_id, visibility)
       VALUES ($1, '@cinatra-ai/dynamic:email-followup-bundle', $2::jsonb, $3, $4, 'uat-seed', 'organization', $4, 'organization')
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data,
         org_id = EXCLUDED.org_id, created_by = EXCLUDED.created_by,
         owner_level = EXCLUDED.owner_level, owner_id = EXCLUDED.owner_id,
         visibility = EXCLUDED.visibility,
         updated_at = now()`,
      [id, JSON.stringify(data), userId, orgId],
    ),
  );
  return id;
}

/**
 * Seed a `@cinatra-ai/dynamic:approved-email-draft-bundle` row. Distinct
 * from the unapproved draft bundle (used by reviewer-agent input) — this
 * is what the reviewer SAVES after approval, what email-delivery-agent
 * reads via `approvedDraftBundleRef`.
 */
export async function seedApprovedDraftBundle(
  id: string = SEED_IDS.approvedDraftBundleA,
): Promise<string> {
  const { userId, orgId } = await resolveTestActor();
  const data = {
    drafts: [
      {
        contactId: "00000000-0000-0000-0000-00000000abcd",
        recipientEmail: "pat@example.com",
        subject: "Quick thought on your outreach pipeline",
        body:
          "Hi Pat,\n\nNoticed Example Co is hiring four BDR roles in Q3 — " +
          "we help teams in your spot cut manual outreach overhead by ~70%. " +
          "Worth a 15-min look?\n\nBest,\nUAT Sender",
      },
    ],
  };
  await withPg((c) =>
    c.query(
      `INSERT INTO ${SCHEMA}.objects (id, type, data, created_by, org_id, source, owner_level, owner_id, visibility)
       VALUES ($1, '@cinatra-ai/dynamic:approved-email-draft-bundle', $2::jsonb, $3, $4, 'uat-seed', 'organization', $4, 'organization')
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data,
         org_id = EXCLUDED.org_id, created_by = EXCLUDED.created_by,
         owner_level = EXCLUDED.owner_level, owner_id = EXCLUDED.owner_id,
         visibility = EXCLUDED.visibility,
         updated_at = now()`,
      [id, JSON.stringify(data), userId, orgId],
    ),
  );
  return id;
}

/**
 * Seed a `@cinatra-ai/campaigns:recipients` row that email-delivery /
 * email-outreach reads via `confirmedRecipientsRef`. Shape matches what
 * email-recipient-selection-agent SAVES on approve.
 */
export async function seedConfirmedRecipients(
  id: string = SEED_IDS.confirmedRecipientsA,
): Promise<string> {
  const { userId, orgId } = await resolveTestActor();
  const data = {
    confirmedRecipients: [
      {
        contactId: "00000000-0000-0000-0000-00000000abcd",
        accountId: "00000000-0000-0000-0000-00000000acc1",
        name: "Pat Casey",
        email: "pat@example.com",
        title: "VP Engineering",
        accountName: "Example Co",
      },
    ],
  };
  await withPg((c) =>
    c.query(
      `INSERT INTO ${SCHEMA}.objects (id, type, data, created_by, org_id, source, owner_level, owner_id, visibility)
       VALUES ($1, '@cinatra-ai/campaigns:recipients', $2::jsonb, $3, $4, 'uat-seed', 'organization', $4, 'organization')
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data,
         org_id = EXCLUDED.org_id, created_by = EXCLUDED.created_by,
         owner_level = EXCLUDED.owner_level, owner_id = EXCLUDED.owner_id,
         visibility = EXCLUDED.visibility,
         updated_at = now()`,
      [id, JSON.stringify(data), userId, orgId],
    ),
  );
  return id;
}

export async function seedContactList(
  id: string = SEED_IDS.contactListA,
  memberRefs: ReadonlyArray<string> = [],
): Promise<string> {
  const { userId, orgId } = await resolveTestActor();
  const now = new Date().toISOString();
  const data = {
    name: "UAT Recipients — Example",
    createdAt: now,
    updatedAt: now,
    memberType: "contact",
    membership: { kind: "static", memberRefs },
    ownerUserId: userId,
  };
  await withPg((c) =>
    c.query(
      // Set the full ownership tuple. See seedCampaignContext above for
      // why visibility=organization is required.
      `INSERT INTO ${SCHEMA}.objects (id, type, data, created_by, org_id, source, owner_level, owner_id, visibility)
       VALUES ($1, '@cinatra-ai/lists:list', $2::jsonb, $3, $4, 'uat-seed', 'organization', $4, 'organization')
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data,
         org_id = EXCLUDED.org_id, created_by = EXCLUDED.created_by,
         owner_level = EXCLUDED.owner_level, owner_id = EXCLUDED.owner_id,
         visibility = EXCLUDED.visibility,
         updated_at = now()`,
      [id, JSON.stringify(data), userId, orgId],
    ),
  );
  return id;
}

