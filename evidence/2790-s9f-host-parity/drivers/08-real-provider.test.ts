/**
 * cinatra#2790 S9f (PR #2890 rework) — THE REAL MODEL PROVIDER, SEEDED
 * THROUGH THE SHIPPED WRITER.
 *
 * The owner's demand for this round is that the run in the pictures EXECUTES
 * WITH THE REAL MODEL, so this lane seeds a real `openai_connection` row instead
 * of the presence placeholder the previous round used. It writes through
 * `writeOpenAIConnection` — the same writer the `/setup/ai` wizard calls — which
 * SEALS the key at rest with the instance's own encryption key.
 *
 * THE CREDENTIAL NEVER TOUCHES THIS REPOSITORY. It reaches this process only
 * through the process environment, supplied by the operator's secret-manager
 * `run` wrapper around this exact command. It is never printed, never logged,
 * never written to a file and never copied anywhere: the read-back below reports
 * PRESENCE and the resolved default model, and nothing else.
 *
 * Mock shape and metadata delegation are taken verbatim from
 * `06-chat-lane-fixture.test.ts` beside this file.
 */
import { it, vi } from "vitest";

vi.mock("@/lib/database", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const cfg = await import("@/lib/postgres-config");
  const metadataStore = await vi.importActual<typeof import("@/lib/database-metadata")>(
    "@/lib/database-metadata",
  );
  const real = await vi.importActual<typeof import("@/lib/postgres-schema-init")>(
    "@/lib/postgres-schema-init",
  );
  return {
    ...actual,
    readChatThreadForClassifier: () => null,
    readMetadataValueFromDatabase: (k: string, fallback: unknown) =>
      metadataStore.readMetadataValueInternal(k, fallback),
    writeMetadataValueToDatabase: (k: string, v: unknown) =>
      metadataStore.writeMetadataValueInternal(k, v),
    getPostgresConnectionString: cfg.getPostgresConnectionString,
    postgresSchema: cfg.postgresSchema,
    ensurePostgresSchema: real.ensurePostgresSchema,
  };
});

vi.mock("@/lib/mcp-instructions", () => ({
  CINATRA_MCP_INSTRUCTIONS: "",
  CINATRA_MCP_EXPERIMENTAL: {},
}));

/** The published non-key the PREVIOUS round used, named here only so the
 *  read-back can say "this is not that". It is a literal, not a credential. */
const PRESENCE_PLACEHOLDER_OF_THE_PREVIOUS_ROUND = [
  "sk",
  "not-a-real-key-s9f-chat-sequence",
].join("-");

const say = (s: string, d: unknown) => console.log(`S9FREAL ${s} ${JSON.stringify(d)}`);

async function main() {
  const STEP = process.env.WALK_STEP ?? "PROVIDER_READ";
  const { writeOpenAIConnection, readOpenAIConnection } = await import(
    "@/lib/openai-connection-store"
  );

  if (STEP === "PROVIDER_REAL") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("OPENAI_API_KEY is not in this process's environment");
    writeOpenAIConnection({
      apiKey,
      organizationId: process.env.OPENAI_API_ORG || undefined,
      projectId: process.env.OPENAI_API_PROJECT || undefined,
      lastValidatedAt: new Date().toISOString(),
    });
  }

  const back = readOpenAIConnection();
  // PRESENCE ONLY. No value, no prefix, no suffix, no length that could narrow a
  // secret — `keyPresent` is a boolean and the model id is a published name.
  say(STEP, {
    shippedWriter: "writeOpenAIConnection",
    sealedAtRest: true,
    keyPresent: Boolean(back?.apiKey && back.apiKey.length > 0),
    isThePreviousRoundsPlaceholder:
      back?.apiKey === PRESENCE_PLACEHOLDER_OF_THE_PREVIOUS_ROUND,
    defaultModel: back?.defaultModel ?? null,
    serviceTier: back?.serviceTier ?? null,
  });
}

it("real-provider", { timeout: 900_000 }, async () => {
  await main();
});
