// Contract test for the artifact-claim-registry migration
// (migrations/core/core__0034_artifact-claim-registry.mjs, cinatra#1425,
// epic #1424 foundation).
//
// The migration module is imported by RELATIVE PATH so the real SQL is
// exercised. Pure unit test (no DB): it pins the shape of up()/down() — the
// three tables, the constraint-backed arbitration (the two partial unique
// indexes), the append-only event trigger, idempotency, and a clean reversal
// — plus the bootstrap-DDL parity: the migration and
// `artifactClaimSchemaQueries` (the buildCreateStoreSchemaQueries leaf) must
// create the same tables/constraints, or the fresh-install and
// operator-upgrade paths diverge. It also pins the ACCEPTANCE-CRITERIA-
// bearing DDL properties:
//   AC-1: two DEDICATED claimants on the same (scope, type) are rejected by
//         the `artifact_type_claims_one_live_dedicated` partial unique index.
//   AC-3: claim-event history has NO foreign key (nothing cascades when the
//         installed_extension row is deleted on uninstall) and is
//         trigger-enforced append-only.
// And the vocabulary sync: the DDL CHECK value sets equal the pure policy
// leaf's (`@cinatra-ai/objects/claims`) — the schema contract.

import { describe, expect, it } from "vitest";

import {
  ARTIFACT_CLAIM_EVENTS,
  ARTIFACT_CLAIM_KINDS,
  ARTIFACT_CLAIM_STATUSES,
} from "@cinatra-ai/objects/claims";

import { up, down } from "../../../migrations/core/core__0034_artifact-claim-registry.mjs";
import { artifactClaimSchemaQueries } from "@/lib/artifact-claim-schema";

function collectSql(fn: (b: { sql: (s: string) => void }) => void): string[] {
  const out: string[] = [];
  fn({ sql: (s: string) => out.push(s) });
  return out;
}

const upSql = collectSql(up as (b: { sql: (s: string) => void }) => void).join("\n");
const downSql = collectSql(down as (b: { sql: (s: string) => void }) => void).join("\n");
const bootstrapSql = artifactClaimSchemaQueries("cinatra")
  .map((q) => q.text)
  .join("\n");

const TABLES = ["artifact_type_claims", "artifact_claim_events", "artifact_binding_reconcile_queue"];

describe("core__0034 up()", () => {
  it("creates the three claim tables, idempotently", () => {
    for (const table of TABLES) {
      expect(upSql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    }
  });

  it("AC-1 backing: partial unique index rejects a second live DEDICATED claimant per (scope, type)", () => {
    expect(upSql).toContain("CREATE UNIQUE INDEX IF NOT EXISTS artifact_type_claims_one_live_dedicated");
    expect(upSql).toMatch(
      /artifact_type_claims_one_live_dedicated\s*\n?\s*ON artifact_type_claims \(scope, object_type_id\) WHERE claim_kind = 'dedicated' AND status <> 'retired'/,
    );
  });

  it("enforces ONE ACTIVE claim per scope key (the issue's partial-unique on ACTIVE)", () => {
    expect(upSql).toMatch(
      /artifact_type_claims_one_active_per_scope_type\s*\n?\s*ON artifact_type_claims \(scope, object_type_id\) WHERE status = 'active'/,
    );
  });

  it("enforces ONE live DEFAULT claimant per scope key (makes dormancy/reactivation total — at most one dormant default can ever reactivate into a scope key's active slot)", () => {
    expect(upSql).toMatch(
      /artifact_type_claims_one_live_default\s*\n?\s*ON artifact_type_claims \(scope, object_type_id\) WHERE claim_kind = 'default' AND status <> 'retired'/,
    );
  });

  it("rejects the empty org scope ('org:') and gives events a monotonic order (seq identity)", () => {
    expect(upSql).toContain("scope = 'platform' OR scope LIKE 'org:_%'");
    expect(upSql).toMatch(/seq bigint GENERATED ALWAYS AS IDENTITY/);
  });

  it("AC-3 backing: the event log carries NO foreign keys and is append-only via trigger", () => {
    // No REFERENCES anywhere in the events table DDL — deleting the
    // installed_extension row (uninstall) or the claim row can never cascade
    // into (or be blocked by) history.
    const eventsDdl = upSql.slice(upSql.indexOf("artifact_claim_events ("), upSql.indexOf("CREATE INDEX IF NOT EXISTS artifact_claim_events_claim_idx"));
    expect(eventsDdl.length).toBeGreaterThan(0);
    expect(eventsDdl).not.toMatch(/REFERENCES/i);
    expect(upSql).toContain("CREATE TRIGGER trg_artifact_claim_events_append_only BEFORE UPDATE OR DELETE ON artifact_claim_events");
    expect(upSql).toMatch(/RAISE EXCEPTION 'artifact_claim_events is append-only/);
  });

  it("claims carry install provenance WITHOUT an FK (claims survive uninstall's row delete)", () => {
    const claimsDdl = upSql.slice(upSql.indexOf("artifact_type_claims ("), upSql.indexOf("artifact_claim_events ("));
    expect(claimsDdl).toMatch(/install_id text/);
    expect(claimsDdl).not.toMatch(/REFERENCES/i);
  });

  it("queue rows are typed binding-reconcile | re-projection", () => {
    expect(upSql).toMatch(/kind IN \('binding-reconcile','re-projection'\)/);
  });

  it("keeps the DDL CHECK vocabularies in sync with the @cinatra-ai/objects claims leaf", () => {
    expect(upSql).toContain(`claim_kind IN (${ARTIFACT_CLAIM_KINDS.map((k) => `'${k}'`).join(",")})`);
    expect(upSql).toContain(`status IN (${ARTIFACT_CLAIM_STATUSES.map((s) => `'${s}'`).join(",")})`);
    expect(upSql).toContain(`event IN (${ARTIFACT_CLAIM_EVENTS.map((e) => `'${e}'`).join(",")})`);
    // Dormancy is a DEFAULT-claim-only state, DB-enforced.
    expect(upSql).toContain("status <> 'dormant' OR claim_kind = 'default'");
  });
});

describe("bootstrap-DDL parity (fresh install == operator upgrade)", () => {
  it("the migration and the bootstrap leaf agree on tables, indexes, constraints", () => {
    const mustMatch = [
      "artifact_type_claims_one_active_per_scope_type",
      "artifact_type_claims_one_live_dedicated",
      "artifact_type_claims_one_live_default",
      "seq bigint GENERATED ALWAYS AS IDENTITY",
      "artifact_type_claims_scope_check",
      "artifact_type_claims_kind_check",
      "artifact_type_claims_status_check",
      "artifact_type_claims_dormant_default_check",
      "artifact_claim_events_event_check",
      "trg_artifact_claim_events_append_only",
      "fn_artifact_claim_events_append_only",
      "artifact_binding_reconcile_queue_kind_check",
      "artifact_binding_reconcile_queue_status_check",
      ...TABLES,
    ];
    for (const token of mustMatch) {
      expect(upSql).toContain(token);
      expect(bootstrapSql).toContain(token);
    }
    // Same column vocabulary in both claim-table DDLs (order-insensitive).
    for (const column of [
      "scope text NOT NULL",
      "object_type_id text NOT NULL",
      "claim_kind text NOT NULL",
      "extension_package text NOT NULL",
      "extension_version text NOT NULL",
      "install_id text",
      "generation integer NOT NULL DEFAULT 1",
      "dispositions jsonb",
    ]) {
      expect(upSql).toContain(column);
      expect(bootstrapSql).toContain(column);
    }
  });

  it("the bootstrap leaf schema-qualifies every statement (variable schema contract)", () => {
    for (const q of artifactClaimSchemaQueries("cinatra")) {
      expect(q.text).toContain('"cinatra".');
    }
  });
});

describe("core__0034 down()", () => {
  it("cleanly reverses: drops the three tables + trigger/function, nothing else", () => {
    for (const table of TABLES) {
      expect(downSql).toContain(`DROP TABLE IF EXISTS ${table}`);
    }
    expect(downSql).toContain("DROP TRIGGER IF EXISTS trg_artifact_claim_events_append_only");
    expect(downSql).toContain("DROP FUNCTION IF EXISTS fn_artifact_claim_events_append_only()");
    expect(downSql).not.toMatch(/DROP TABLE (?!IF EXISTS (artifact_type_claims|artifact_claim_events|artifact_binding_reconcile_queue))/);
  });
});
