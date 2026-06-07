// Prove the LEGACY writer paths
// (objects-store.ts upsertObjectAndEnqueue + softDeleteObject) emit an
// object_change_event in the same CTE as the object mutation + outbox
// enqueue.
//
// This is a SOURCE-FIXTURE test (like canonical-writer-sql-shape) rather
// than a live DB test — it locks the SQL shape so a future refactor
// can't accidentally remove the event_row CTE.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const OBJECTS_STORE_PATH = join(__dirname, "..", "..", "objects-store.ts");
const SOURCE = readFileSync(OBJECTS_STORE_PATH, "utf8");

describe("legacy writer paths (objects-store.ts) emit history events", () => {
  describe("upsertObjectAndEnqueue", () => {
    it("CTE chain includes a new_changeset INSERT", () => {
      expect(SOURCE).toMatch(
        /new_changeset AS \([\s\S]*?INSERT INTO "\$\{schema\}"\."change_set"/,
      );
    });

    it("CTE chain includes an event_row INSERT into object_change_event", () => {
      expect(SOURCE).toMatch(
        /event_row AS \([\s\S]*?INSERT INTO "\$\{schema\}"\."object_change_event"/,
      );
    });

    it("event_row captures before/after snapshots", () => {
      expect(SOURCE).toMatch(/\(SELECT payload FROM base_row\)/);
      expect(SOURCE).toMatch(/row_to_json\(upserted\)::jsonb/);
    });

    it("base_row CTE is at the top of the chain (pre-write)", () => {
      // base_row must appear before upserted so it captures the BEFORE state.
      const baseRowIdx = SOURCE.indexOf("base_row AS (");
      const upsertedIdx = SOURCE.indexOf("upserted AS (");
      expect(baseRowIdx).toBeGreaterThan(0);
      expect(upsertedIdx).toBeGreaterThan(baseRowIdx);
    });

    it("operation column distinguishes create from update", () => {
      expect(SOURCE).toMatch(
        /CASE WHEN \(SELECT version FROM base_row\) IS NULL THEN 'create' ELSE 'update' END/,
      );
    });

    it("history_effect is 'reversible-internal' for legacy writers", () => {
      expect(SOURCE).toMatch(/'reversible-internal'/);
    });
  });

  describe("softDeleteObject — after_snapshot capture", () => {
    it("RETURNING includes row_to_json post-delete (after_snapshot source)", () => {
      const softDeleteSection = SOURCE.slice(
        SOURCE.indexOf("export function softDeleteObject("),
        SOURCE.indexOf("export function upsertObjectAndEnqueue("),
      );
      // Post-delete row_json MUST be captured so restoreObjectToVersion can
      // read after_snapshot when the target version was a soft-delete event.
      expect(softDeleteSection).toMatch(
        /RETURNING[\s\S]+row_to_json\("\$\{schema\}"\."objects"\.\*\)::jsonb AS row_json/,
      );
    });

    it("event_row writes deleted.row_json as after_snapshot (not NULL)", () => {
      const softDeleteSection = SOURCE.slice(
        SOURCE.indexOf("export function softDeleteObject("),
        SOURCE.indexOf("export function upsertObjectAndEnqueue("),
      );
      expect(softDeleteSection).toMatch(
        /\(SELECT payload FROM base_row\), deleted\.row_json/,
      );
      // And we don't fall back to NULL for after_snapshot in this path.
      expect(softDeleteSection).not.toMatch(
        /\(SELECT payload FROM base_row\), NULL,/,
      );
    });
  });

  describe("softDeleteObject", () => {
    it("CTE chain includes a new_changeset INSERT", () => {
      const softDeleteSection = SOURCE.slice(
        SOURCE.indexOf("export function softDeleteObject("),
        SOURCE.indexOf("export function upsertObjectAndEnqueue("),
      );
      expect(softDeleteSection).toMatch(
        /new_changeset AS \([\s\S]*?INSERT INTO "\$\{schema\}"\."change_set"/,
      );
    });

    it("CTE chain includes an event_row INSERT", () => {
      const softDeleteSection = SOURCE.slice(
        SOURCE.indexOf("export function softDeleteObject("),
        SOURCE.indexOf("export function upsertObjectAndEnqueue("),
      );
      expect(softDeleteSection).toMatch(
        /event_row AS \([\s\S]*?INSERT INTO "\$\{schema\}"\."object_change_event"/,
      );
    });

    it("operation column is 'soft-delete'", () => {
      const softDeleteSection = SOURCE.slice(
        SOURCE.indexOf("export function softDeleteObject("),
        SOURCE.indexOf("export function upsertObjectAndEnqueue("),
      );
      expect(softDeleteSection).toMatch(/'soft-delete'/);
    });

    it("captures before_snapshot via base_row CTE", () => {
      const softDeleteSection = SOURCE.slice(
        SOURCE.indexOf("export function softDeleteObject("),
        SOURCE.indexOf("export function upsertObjectAndEnqueue("),
      );
      expect(softDeleteSection).toMatch(/\(SELECT payload FROM base_row\)/);
    });
  });

  describe("idempotency + identity", () => {
    it("uses randomUUID for change_set + event ids (no collisions)", () => {
      expect(SOURCE).toMatch(/cs_legacy_\$\{randomUUID\(\)\}/);
      expect(SOURCE).toMatch(/che_legacy_\$\{randomUUID\(\)\}/);
    });

    it("computes event_checksum via sha256 over a stable identity tuple", () => {
      expect(SOURCE).toMatch(
        /createHash\("sha256"\)[\s\S]*?\.update\(`legacy-writer:/,
      );
    });
  });
});
