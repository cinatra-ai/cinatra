/**
 * Return the instance to its PRE-SETUP AI-step state so the walk below runs as
 * one coherent narrative instead of on residue from an earlier pass.
 *
 * Deletes exactly the rows the AI step owns — nothing else. The instance stays a
 * real, migrated, extension-activated instance; only the AI step's own durable
 * state (the pick, the receipt, the last failure, the committed default, both
 * providers' stored connections) and the Anthropic upload bookkeeping go away.
 */
import { execFileSync } from "node:child_process";

const CONTAINER = process.env.LANE_PG_CONTAINER ?? "s6-2093-pg";

const statements = [
  `delete from cinatra.metadata where key in (
     'connector_config:llm_default_provider',
     'connector_config:setup_provider_selection',
     'connector_config:setup_readiness_receipt',
     'connector_config:setup_readiness_last_failure',
     'connector_config:anthropic',
     'connector_config:anthropic_connection',
     'connector_config:anthropic_skill_sync_enabled',
     'openai_connection'
   );`,
  `delete from cinatra.anthropic_skill_sync;`,
  `delete from cinatra.anthropic_skill_reconcile_outbox;`,
  `delete from cinatra.anthropic_skill_lease;`,
  `delete from cinatra.skill_upload_consent;`,
];

for (const sql of statements) {
  const out = execFileSync(
    "docker",
    ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { encoding: "utf8" },
  );
  console.log(out.trim());
}
console.log("setup AI-step state reset");
