// Parity + shape tests for the durable environment-layer store DDL (exec-plane
// S3 A2, cinatra#1708). The bootstrap leaf (buildCreateStoreSchemaQueries →
// environmentLayerStoreSchemaQueries) and the core__0057 migration MUST create
// the SAME tables + indexes (additive-mirror invariant), and the reference dedup
// unique MUST be NULLS NOT DISTINCT (so two refs that both leave a holder column
// NULL still collide — reproducing the in-memory addReference dedup).

import { describe, expect, it } from "vitest";

import { environmentLayerStoreSchemaQueries } from "@/lib/execution/environment-layer-schema";
import { environmentLayerStoreDdlSql } from "../../../../migrations/core/core__0057_environment-layer-store.mjs";

const bootstrapSql = environmentLayerStoreSchemaQueries("cinatra")
  .map((q) => q.text)
  .join("\n");
const migrationSql: string = environmentLayerStoreDdlSql;

describe("environment-layer store DDL", () => {
  it("both paths create the two tables", () => {
    for (const sql of [bootstrapSql, migrationSql]) {
      expect(sql).toMatch(/environment_layers/);
      expect(sql).toMatch(/environment_layer_references/);
    }
  });

  it("both paths create the (recipe_key, partition) UNIQUE + the reference dedup NULLS NOT DISTINCT unique", () => {
    for (const sql of [bootstrapSql, migrationSql]) {
      expect(sql).toMatch(/environment_layers_recipe_partition_uniq/);
      expect(sql).toMatch(/environment_layer_references_dedup_uniq/);
      // The dedup unique MUST be NULLS NOT DISTINCT (Codex nullable-tuple finding).
      expect(sql).toMatch(/NULLS NOT DISTINCT/);
    }
  });

  it("partition is NOT NULL in both paths (no nullable-column duplicate hazard)", () => {
    for (const sql of [bootstrapSql, migrationSql]) {
      expect(sql).toMatch(/partition\s+text NOT NULL/);
    }
  });

  it("both paths index spec_key (builder fast path) + recipe_key (countReferences)", () => {
    for (const sql of [bootstrapSql, migrationSql]) {
      expect(sql).toMatch(/environment_layers_spec_key_idx/);
      expect(sql).toMatch(/environment_layer_references_recipe_idx/);
    }
  });
});
