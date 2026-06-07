/**
 * Workflow approval notification UI rendering UAT.
 *
 * Scope: end-to-end verification that the notification archive page renders
 * the approval-flow rows the host notifier writes — for both `approval_needed`
 * (admin/approver path) and `approval_resolved` (requester path, approve + reject).
 *
 * The actual emission code paths are unit-tested separately:
 *   - The matrix + envelope shape: packages/workflows/src/__tests__/notifications.test.ts
 *   - The reconciler `approval_needed` emit: packages/workflows/src/__tests__/engine.integration.test.ts:246
 *
 * This spec verifies the UI side of the contract — that the notification rows
 * the production notifier writes (kind, title, body, href) actually render in
 * the archive with the expected content.
 *
 * The notification surface is read-only for new rows (only PATCH for
 * read-state), so we seed via direct-pg the same way notifications-flyout
 * does. We seed three rows the host notifier (`src/lib/workflow-notifier.ts`)
 * would write:
 *   1. approval_needed → "Approval needed" (info kind)
 *   2. approval_resolved (approved decision) → "Approval decided" (info kind)
 *   3. approval_resolved (rejected decision) → "Approval decided" (info kind)
 *
 * Body text exactly matches what `bodyFor` produces for each event so the spec
 * doubles as a copy-contract pin.
 */
import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Pool } from "pg";

function readEnvLocal(): Record<string, string> {
  try {
    const raw = readFileSync(resolve(process.cwd(), ".env.local"), "utf-8");
    const out: Record<string, string> = {};
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const value = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

const ENV_LOCAL = readEnvLocal();
const EMAIL = process.env.E2E_NOTIF_USER_EMAIL ?? "notif-uat@local.test";
const DATABASE_URL =
  process.env.SUPABASE_DB_URL ??
  ENV_LOCAL.SUPABASE_DB_URL ??
  "postgresql://postgres:postgres@127.0.0.1:5434/postgres";
const SCHEMA =
  process.env.SUPABASE_SCHEMA ?? ENV_LOCAL.SUPABASE_SCHEMA ?? "cinatra";

const APPROVAL_NEEDED_ID = "notif-approval-uat-approval-needed-1";
const APPROVAL_APPROVED_ID = "notif-approval-uat-approval-resolved-approved-1";
const APPROVAL_REJECTED_ID = "notif-approval-uat-approval-resolved-rejected-1";

// Plausible workflow ids the host notifier would route to. These do NOT need
// matching rows in workflow / workflow_task — the notification table carries
// title/body/href as fully resolved strings; the workflow detail page is not
// under test here.
const WORKFLOW_A_ID = "notif-approval-uat-wf-launch";
const WORKFLOW_B_ID = "notif-approval-uat-wf-release";
const WORKFLOW_C_ID = "notif-approval-uat-wf-deploy";

async function resolveUserId(): Promise<string> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  try {
    const r = await pool.query<{ id: string }>(
      `SELECT id FROM public."user" WHERE email = $1 LIMIT 1`,
      [EMAIL],
    );
    if (r.rows.length === 0) {
      throw new Error(`workflow-approval UAT: user not found for ${EMAIL} — auth.setup must run first`);
    }
    return r.rows[0].id;
  } finally {
    await pool.end();
  }
}

async function seedApprovalNotifications(userId: string): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const schema = `"${SCHEMA.replaceAll('"', '""')}"`;
  try {
    // Idempotent reset so re-runs are deterministic.
    await pool.query(
      `DELETE FROM ${schema}.notifications WHERE user_id = $1 AND id LIKE $2`,
      [userId, "notif-approval-uat-%"],
    );

    // 1. approval_needed — host notifier writes this when an approval is
    //    solicited. Title + body match COPY + bodyFor in workflow-notifier.ts.
    await pool.query(
      `INSERT INTO ${schema}.notifications
        (id, user_id, recipient_kind, recipient_id, topic, kind, title, body, href, metadata, source_job_id, source_job_name, created_at, read_at)
        VALUES ($1, $2, 'user', $2, 'user:' || $2, 'info', $3, $4, $5, NULL, $6, 'workflow-approval-needed', now() - interval '3 minutes', NULL)
        ON CONFLICT (user_id, source_job_id, kind)
          WHERE source_job_id IS NOT NULL AND user_id IS NOT NULL
          DO NOTHING`,
      [
        APPROVAL_NEEDED_ID,
        userId,
        "Approval needed",
        "Q3 Launch is waiting for your approval.",
        `/workflows/${WORKFLOW_A_ID}`,
        `job-${APPROVAL_NEEDED_ID}`,
      ],
    );

    // 2. approval_resolved (approved) — host notifier writes this when an
    //    approval is approved. Body matches what bodyFor renders for an
    //    approved decision with decidedBy + reason.
    await pool.query(
      `INSERT INTO ${schema}.notifications
        (id, user_id, recipient_kind, recipient_id, topic, kind, title, body, href, metadata, source_job_id, source_job_name, created_at, read_at)
        VALUES ($1, $2, 'user', $2, 'user:' || $2, 'info', $3, $4, $5, NULL, $6, 'workflow-approval-decided', now() - interval '2 minutes', NULL)
        ON CONFLICT (user_id, source_job_id, kind)
          WHERE source_job_id IS NOT NULL AND user_id IS NOT NULL
          DO NOTHING`,
      [
        APPROVAL_APPROVED_ID,
        userId,
        "Approval decided",
        "Your approval request on Release v2 (Sign-off gate) was approved by user-admin. Note: looks good",
        `/workflows/${WORKFLOW_B_ID}`,
        `job-${APPROVAL_APPROVED_ID}`,
      ],
    );

    // 3. approval_resolved (rejected) — same event, rejected decision.
    await pool.query(
      `INSERT INTO ${schema}.notifications
        (id, user_id, recipient_kind, recipient_id, topic, kind, title, body, href, metadata, source_job_id, source_job_name, created_at, read_at)
        VALUES ($1, $2, 'user', $2, 'user:' || $2, 'info', $3, $4, $5, NULL, $6, 'workflow-approval-decided', now() - interval '1 minute', NULL)
        ON CONFLICT (user_id, source_job_id, kind)
          WHERE source_job_id IS NOT NULL AND user_id IS NOT NULL
          DO NOTHING`,
      [
        APPROVAL_REJECTED_ID,
        userId,
        "Approval decided",
        "Your approval request on Deploy hotfix (Gate B) was rejected by user-admin. Note: needs more context",
        `/workflows/${WORKFLOW_C_ID}`,
        `job-${APPROVAL_REJECTED_ID}`,
      ],
    );
  } finally {
    await pool.end();
  }
}

async function cleanupApprovalNotifications(userId: string): Promise<void> {
  const pool = new Pool({ connectionString: DATABASE_URL });
  const schema = `"${SCHEMA.replaceAll('"', '""')}"`;
  try {
    await pool.query(
      `DELETE FROM ${schema}.notifications WHERE user_id = $1 AND id LIKE $2`,
      [userId, "notif-approval-uat-%"],
    );
  } finally {
    await pool.end();
  }
}

test.describe.configure({ timeout: 120_000 });

test.describe("workflow approval notifications", () => {
  let userId = "";

  test.beforeAll(async () => {
    userId = await resolveUserId();
    await seedApprovalNotifications(userId);
  });

  test.afterAll(async () => {
    if (userId) await cleanupApprovalNotifications(userId);
  });

  test("approval_needed notification renders in /notifications with approver-facing body", async ({
    page,
  }) => {
    await page.goto("/notifications", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Notifications", level: 1 })).toBeVisible({
      timeout: 60_000,
    });

    // Title from COPY[approval_needed].title
    await expect(page.getByText("Approval needed").first()).toBeVisible();
    // Body from bodyFor("approval_needed", ...).
    await expect(page.getByText("Q3 Launch is waiting for your approval.")).toBeVisible();
  });

  test("approval_resolved (approved) renders the decider + reason for the requester", async ({
    page,
  }) => {
    await page.goto("/notifications", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Notifications", level: 1 })).toBeVisible({
      timeout: 60_000,
    });

    // Title from COPY[approval_resolved].title — single string per the COPY
    // entry. bodyFor encodes the decision verb + decider + optional reason.
    await expect(
      page.getByText(
        "Your approval request on Release v2 (Sign-off gate) was approved by user-admin. Note: looks good",
      ),
    ).toBeVisible();
  });

  test("approval_resolved (rejected) renders the rejection + decider + reason", async ({
    page,
  }) => {
    await page.goto("/notifications", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("heading", { name: "Notifications", level: 1 })).toBeVisible({
      timeout: 60_000,
    });

    await expect(
      page.getByText(
        "Your approval request on Deploy hotfix (Gate B) was rejected by user-admin. Note: needs more context",
      ),
    ).toBeVisible();
  });
});
