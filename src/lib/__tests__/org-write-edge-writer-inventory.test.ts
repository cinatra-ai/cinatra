// cinatra#1939 — the remaining edge-family write inventory (webhook/connector
// mutation routes, notifications, artifact upload, CLI import/reconcile,
// auditor, org-scoped chat). The genuinely new unregistered writers this sweep
// found are registered with an exemption in write-registry.ts (see the block
// of rows there citing this file); everything below is the OTHER outcome —
// families with no organization-axis write at all, or one already accounted
// for by an existing registered/exempted writer. Each assertion reads the
// real source/schema so a regression (someone adding an org column, or a raw
// write, where today there is none) fails this suite instead of going unseen.
import { readFileSync, existsSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { ORG_WRITE_REGISTRY } from "../org-write/write-registry";

function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => " ".repeat(m.length))
    .replace(/\/\/[^\n]*/g, (m) => " ".repeat(m.length));
}

const DML_VERBS_RE = /\.(insert|update|delete)\(|(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s/i;

describe("notifications — no organization axis", () => {
  const ddl = readFileSync("src/lib/drizzle-store.ts", "utf-8");
  const block = ddl.slice(ddl.indexOf('."notifications" ALTER COLUMN'), ddl.indexOf("notifications_topic_created_idx"));

  it('positive control: the block-extraction actually found the notifications DDL', () => {
    expect(block.length).toBeGreaterThan(200);
    expect(block).toContain("user_id");
  });

  it("the notifications table declares no org_id / organization_id column", () => {
    expect(block).not.toMatch(/\borg_id\b/i);
    expect(block).not.toMatch(/\borganization_id\b/i);
  });

  it("the recipient-kind org id is a write-time input only, never a persisted column (schema-contract test owns the full column pin)", () => {
    expect(existsSync("src/lib/notifications/__tests__/schema-contract.test.ts")).toBe(true);
  });
});

describe("auditor — the only live write path has no organization axis", () => {
  const schema = readFileSync("packages/agents/src/schema.ts", "utf-8");
  const start = schema.indexOf('table("auditor_proposal_snapshots"');
  const block = schema.slice(start, schema.indexOf('"auditor_approval_receipts"', start));

  it("positive control: the block-extraction actually found the table definition", () => {
    expect(start).toBeGreaterThan(-1);
    expect(block).toContain("agentRunId");
  });

  it("auditor_proposal_snapshots declares no organizationId / orgId / org_id column", () => {
    expect(block).not.toMatch(/\borg_id\b/i);
    expect(block).not.toMatch(/organizationId/i);
  });

  it("the legacy apply/exclude mutation routes stay retired (no resurrection without a fresh review)", () => {
    expect(existsSync("src/app/api/auditor/apply")).toBe(false);
    expect(existsSync("src/app/api/auditor/exclude")).toBe(false);
  });
});

describe("webhook mutation routes — no organization-axis write in repo", () => {
  const webhookSchema = readFileSync("packages/webhooks/src/schema.ts", "utf-8");
  const idempotencyBlock = webhookSchema.slice(
    webhookSchema.indexOf('"webhook_idempotency"'),
    webhookSchema.indexOf('"webhook_secret_bindings"'),
  );
  const secretBindingsBlock = webhookSchema.slice(webhookSchema.indexOf('"webhook_secret_bindings"'));

  it("positive control: both webhook table blocks were found", () => {
    expect(idempotencyBlock).toContain("messageId");
    expect(secretBindingsBlock).toContain("bindingId");
  });

  it("webhook_idempotency and webhook_secret_bindings are siteId-scoped, not organization-scoped", () => {
    for (const block of [idempotencyBlock, secretBindingsBlock]) {
      expect(block).not.toMatch(/\borg_id\b/i);
      expect(block).not.toMatch(/organizationId/i);
    }
  });

  it("the WordPress connector webhook route performs no database write of any kind", () => {
    const src = stripComments(readFileSync("src/app/api/webhooks/wordpress/route.ts", "utf-8"));
    expect(src).not.toMatch(DML_VERBS_RE);
  });

  it("the Nango facade (src/lib/nango-system.ts) performs no database write of any kind — the connection-persisting gateway is a separate, out-of-repo extension", () => {
    const src = stripComments(readFileSync("src/lib/nango-system.ts", "utf-8"));
    expect(src).not.toMatch(DML_VERBS_RE);
  });

  it("the generic inbound webhook route imports no database module of its own — its only write paths are the idempotency ledger and secret service proven org-less above, or the dynamically-dispatched (out-of-repo) connector handler", () => {
    // This route DOES call real writers (ledger.claim/finalize), so a bare
    // DML-verb scan would misfire (it also imports node:crypto's
    // createHash().update(), a false positive for a naive `.update(` match).
    // The precise proof is narrower: no direct database import, so any write
    // this route performs must go through the already-checked ledger/secret
    // modules above, or the connector's own out-of-repo handler.
    const src = readFileSync(
      "src/app/webhook/[vendor]/[slug]/[hook]/[bindingId]/route.ts",
      "utf-8",
    );
    expect(src).toMatch(/imports NO connector/);
    expect(src).not.toMatch(/@\/lib\/(database|drizzle-store|postgres-sync|postgres-config)/);
    expect(src).not.toMatch(/from\s+["']pg["']/);
  });
});

describe("connect-with-cinatra token exchange — reaches the registered (exempted) connect-sites-store rows", () => {
  it("/api/connect/token/route.ts's write path resolves to connect-sites-store.ts, the module registered above", () => {
    // Not a "no write" family — a real write, already accounted for by the
    // connect-sites-store.ts registry rows. This just pins the traceable link
    // from the route to that module so the two don't drift apart silently.
    const provisioning = readFileSync("src/lib/connect-provisioning.ts", "utf-8");
    expect(provisioning).toMatch(/from\s+["']@\/lib\/connect-sites-store["']/);
    const route = readFileSync("src/app/api/connect/token/route.ts", "utf-8");
    expect(route).toMatch(/connect-provisioning/);
  });
});

describe("CLI import/reconcile — organization axis accounted for", () => {
  it("extension reconcile only ever dispatches NULL-org candidates (shared invariant with the daily auto-update loop, pinned in background-jobs-authority-classification.test.ts)", () => {
    const src = readFileSync("src/lib/extension-auto-update.ts", "utf-8");
    expect(src).toMatch(/\(row\.organizationId\s*\?\?\s*null\)\s*!==\s*null\)\s*continue;/);
  });

  it("agent import (agent-transfer.ts) inserts agent_templates with no org_id column — a platform-admin-only, org-less draft import by design", () => {
    const src = readFileSync("src/lib/cli-api/agent-transfer.ts", "utf-8");
    const insertMatch = src.match(/INSERT INTO \$\{schema\}\.agent_templates\s*\(([^)]*)\)/);
    expect(insertMatch, "expected to find the agent_templates INSERT column list").not.toBeNull();
    const columns = insertMatch![1];
    expect(columns).not.toMatch(/\borg_id\b/i);
    // The file's own comment states the deliberate design; keep the two in lockstep.
    expect(src).toMatch(/NO org predicate/);
  });
});

describe("chat capture — no organization axis", () => {
  const ddl = readFileSync("src/lib/chat-capture-schema.ts", "utf-8");

  it("positive control: the capture-turns DDL was found", () => {
    expect(ddl).toContain("chat_capture_turns");
    expect(ddl).toContain("owner_user_id");
  });

  it("chat_capture_turns declares no org_id / organization_id column (owner_user_id-scoped)", () => {
    expect(ddl).not.toMatch(/\borg_id\b/i);
    expect(ddl).not.toMatch(/\borganization_id\b/i);
  });
});

// ---------------------------------------------------------------------------
// Writer-set lockstep for the newly registered raw-SQL stores: every exported
// function that EXECUTES DML in these modules must have a registry row, and
// every registry row must still correspond to a DML-executing export. A new
// write export added to one of these files fails here until it is registered
// deliberately (the dashboards writer-set pin, generalized to the raw-SQL
// world). Detection is per-module because each store executes differently:
// verb literals in the function body, a call to the module's shared locked-tx
// runner, or a call to the module's shared expiry-sweep helper.
// ---------------------------------------------------------------------------
describe("newly registered stores — writer-set lockstep", () => {
  // Segments split at exported AND module-private function definitions AND
  // top-level const declarations (exported or not), so (a) a private helper's
  // own DML (e.g. a shared expiry sweep) is never mis-attributed to the export
  // textually preceding it, and (b) an `export const name = (...) => DML`
  // arrow-function writer is detected the same as an `export function` one.
  function exportedSegments(file: string): Array<{ name: string; body: string }> {
    const src = stripComments(readFileSync(file, "utf-8"));
    // The const boundaries tolerate a type annotation (`export const x: T =`).
    const parts = src.split(
      /^(?:export (?:async )?function (\w+)|function \w+|export const (\w+)\b[^=\n]*=|const \w+\b[^=\n]*=)/m,
    );
    const out: Array<{ name: string; body: string }> = [];
    // parts: [prefix, exportedFn?, exportedConst?, body, ...]
    for (let i = 1; i < parts.length; i += 3) {
      const exported = parts[i] ?? parts[i + 1];
      const body = parts[i + 2] ?? "";
      if (exported) out.push({ name: exported, body });
    }
    return out;
  }

  const STORE_MODULES = [
    "src/lib/artifacts/semantic-assertion-store.ts",
    "src/lib/connect-sites-store.ts",
    "src/lib/widget-user-auth.ts",
    "src/lib/assistant-thread-store.ts",
    "src/lib/assistant-thread-dormant-content-purge.ts",
  ];

  it("segmenter coverage guard: no store module uses a grouped `export {}` list or `export default` (either would bypass the export-form scan — extend the segmenter before introducing one)", () => {
    for (const file of STORE_MODULES) {
      const src = stripComments(readFileSync(file, "utf-8"));
      expect(src, `${file} uses a grouped export list`).not.toMatch(/^export \{/m);
      expect(src, `${file} uses export default`).not.toMatch(/^export default/m);
    }
  });

  const RAW_VERBS = /(INSERT\s+INTO|UPDATE\s+["$`]|DELETE\s+FROM)/;

  it("per-module DML-site count ratchet: each store module's TOTAL raw-DML surface is pinned wherever it sits (a new site in a private helper or builder — invisible to the export-set pins and, for the constant-hidden stores, to the table sweep — fails here until deliberately re-pinned)", () => {
    const counts: Record<string, number> = {};
    for (const file of STORE_MODULES) {
      const src = stripComments(readFileSync(file, "utf-8"));
      counts[file] = (src.match(new RegExp(RAW_VERBS.source, "g")) ?? []).length;
    }
    expect(counts).toEqual({
      "src/lib/artifacts/semantic-assertion-store.ts": 7,
      "src/lib/connect-sites-store.ts": 6,
      "src/lib/widget-user-auth.ts": 10,
      "src/lib/assistant-thread-store.ts": 8,
      "src/lib/assistant-thread-dormant-content-purge.ts": 1,
    });
  });

  function registryWriters(module: string): string[] {
    return ORG_WRITE_REGISTRY.filter((r) => r.module === module)
      .map((r) => r.exportName)
      .sort();
  }

  it("semantic-assertion-store: exactly the locked-tx executors are registered (builders return statements and are not entry points)", () => {
    const detected = exportedSegments("src/lib/artifacts/semantic-assertion-store.ts")
      .filter((s) => /\brunOneLockedTx\(/.test(s.body))
      .map((s) => s.name)
      .sort();
    expect(detected).toEqual(["archiveAssertion", "assertSemanticType", "confirmAssertion"]);
    expect(registryWriters("src/lib/artifacts/semantic-assertion-store.ts")).toEqual(detected);
  });

  it("connect-sites-store: exactly the raw-DML executors are registered", () => {
    const detected = exportedSegments("src/lib/connect-sites-store.ts")
      .filter((s) => RAW_VERBS.test(s.body))
      .map((s) => s.name)
      .sort();
    expect(detected).toEqual([
      "consumeAuthorizationCode",
      "insertAuthorizationCode",
      "revokeConnectSiteRow",
      "sweepExpiredAuthorizationCodes",
      "touchConnectSiteLastUsed",
      "upsertConnectSiteCredential",
    ]);
    expect(registryWriters("src/lib/connect-sites-store.ts")).toEqual(detected);
  });

  it("widget-user-auth: exactly the raw-DML / expiry-sweeping executors are registered", () => {
    const detected = exportedSegments("src/lib/widget-user-auth.ts")
      .filter((s) => RAW_VERBS.test(s.body) || /\bsweepExpired\(/.test(s.body))
      .map((s) => s.name)
      .sort();
    expect(detected).toEqual([
      "consumeUserWidgetToken",
      "createAuthTransaction",
      "issueUserAuthCode",
      "loadActiveTransaction",
      "redeemUserAuthCode",
    ]);
    expect(registryWriters("src/lib/widget-user-auth.ts")).toEqual(detected);
  });

  it("assistant-thread-store: exactly the raw-DML executors are registered", () => {
    const detected = exportedSegments("src/lib/assistant-thread-store.ts")
      .filter((s) => RAW_VERBS.test(s.body))
      .map((s) => s.name)
      .sort();
    expect(detected).toEqual([
      "appendAssistantTurn",
      "bindAssistantThread",
      "createAssistantThread",
      "ensureThreadSlug",
      "setAssistantThreadPauseParticipant",
      "touchAssistantThread",
      "updateAssistantTurn",
    ]);
    expect(registryWriters("src/lib/assistant-thread-store.ts")).toEqual(detected);
  });

  it("assistant-thread-dormant-content-purge: the migration purge is its module's only DML export and stays registered", () => {
    const detected = exportedSegments("src/lib/assistant-thread-dormant-content-purge.ts")
      .filter((s) => RAW_VERBS.test(s.body))
      .map((s) => s.name)
      .sort();
    expect(detected).toEqual(["purgeBackfilledDormantContentTurns"]);
    expect(registryWriters("src/lib/assistant-thread-dormant-content-purge.ts")).toEqual(detected);
  });

  it("database.ts chat-thread facade: the three executors stay registered (the module is too broad for set-equality; one-way pin)", () => {
    const registered = new Set(registryWriters("src/lib/database.ts"));
    for (const fn of [
      "upsertChatThreadInDatabase",
      "deleteChatThreadFromDatabase",
      "deleteAllChatThreadsFromDatabase",
    ]) {
      expect(registered.has(fn), `${fn} must have a registry row`).toBe(true);
      // and the export still exists in the source (a rename must update the row)
      const src = readFileSync("src/lib/database.ts", "utf-8");
      expect(src).toMatch(new RegExp(`export function ${fn}\\(`));
    }
  });

  it("the three dead write exports are import-banned with the expected allowlists (total ban, or the module's opaque accessors only)", () => {
    const byName = new Map(
      ORG_WRITE_REGISTRY.map((r) => [`${r.module}#${r.exportName}`, r] as const),
    );
    const confirmRow = byName.get("src/lib/artifacts/semantic-assertion-store.ts#confirmAssertion")!;
    const archiveRow = byName.get("src/lib/artifacts/semantic-assertion-store.ts#archiveAssertion")!;
    const bindRow = byName.get("src/lib/assistant-thread-store.ts#bindAssistantThread")!;
    for (const row of [confirmRow, archiveRow, bindRow]) {
      expect(row, "dead-writer row must exist").toBeDefined();
      expect(row.importBanned).toBe(true);
    }
    expect(confirmRow.allowedImporters).toEqual([]);
    expect(archiveRow.allowedImporters).toEqual([]);
    // database.ts lazily requires the whole thread-store module (opaque access),
    // so the gate's intersection rule requires it on this banned row.
    expect(bindRow.allowedImporters).toEqual(["src/lib/database.ts"]);
    // The allowlist entry is a mechanical consequence of that opaque access
    // (database.ts requires the module for its read-only payload
    // reconstructor), NOT a grant to call the dead writer: pin that
    // database.ts never even NAMES bindAssistantThread, so the opaque handle
    // cannot start exercising it without failing this test.
    expect(readFileSync("src/lib/database.ts", "utf-8")).not.toMatch(/bindAssistantThread/);
  });
});
