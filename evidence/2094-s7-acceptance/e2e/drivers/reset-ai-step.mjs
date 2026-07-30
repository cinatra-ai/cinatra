/**
 * Return the instance to its PRE-SETUP AI-STEP state so each provider arm runs
 * as one coherent narrative instead of on residue from the previous arm.
 *
 * This is the wizard's own state surface: it deletes EXACTLY the rows the AI
 * step owns and nothing else. The instance stays the same real, migrated,
 * extension-activated instance with the same real operator account — only the
 * AI step's durable state goes away (the pick, the receipt, the last failure,
 * the committed default provider, both providers' stored connections) plus the
 * Anthropic upload bookkeeping the next arm must not inherit.
 *
 * Carried forward from `evidence/2093-s6-setup/drivers/reset-setup-state.mjs`,
 * which established this as the supported per-arm reset for this wizard. The
 * alternative — a second full lane instance per provider — was rejected as pure
 * cost: it proves nothing the row-scoped reset does not, and doubles the live
 * upload volume against the real API.
 *
 * NOTE the deliberate omission: `cinatra.skills` (the installed catalog) is NOT
 * touched, so the OpenAI arm resolves the SAME injectable set the Anthropic arm
 * did — which is what makes the two arms' per-provider delivery-mode comparison
 * a like-for-like one.
 */
import { execFileSync } from "node:child_process";
import process from "node:process";

const CONTAINER = process.env.LANE_PG_CONTAINER ?? "lane2094-pg";

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
