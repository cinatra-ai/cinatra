import { describe, it, expect, vi } from "vitest";
import {
  extensionForIngestibleMime,
  filenameExtensionMatchesMime,
} from "../attachments/capability-registry";

// cinatra#1891 — LIVE-PROVIDER smoke contract (opt-in). This is the DURABLE gate
// the three-defect history demands: the dead candidate source, the strict-schema
// 400, and the missing-filename 400 were EACH green under a mocked LLM boundary
// and caught only by the live walk. This test round-trips ONE real matcher-shape
// classification against the REAL OpenAI API, exercising both live contracts the
// walks caught — the attachment File's recognized-extension filename (DEFECT-3)
// AND the strict `required ⊇ properties` output schema (DEFECT-2). It is SKIPPED
// unless explicitly opted in, so it never touches the network in CI or normal
// runs. See the footer for how the staged walk stack runs it.
//
// It drives the REAL OpenAI provider adapter (uploadFile + generateWithFileInput
// — the same two provider calls the matcher runtime makes); only the logging
// surface is stubbed to a no-op so the adapter loads without app deps. The full
// end-to-end path (BullMQ → matcher-runtime → attachment-resolver-ports →
// provider → DRAFT row) is proven by the staged live walk itself.

vi.mock("server-only", () => ({}));
vi.mock("@/lib/llm-provider-surfaces", () => ({
  getLlmProviderAdapterSurface: () => null,
  getLlmProviderSurface: () => null,
  requireLlmProviderSurface: () => {
    throw new Error("not installed");
  },
  listLlmProviderSurfaces: () => [],
}));

import { createOpenAIProviderAdapter } from "../providers/openai";

// The EXACT matcher output schema (cinatra#1891): `required` ⊇ every key in
// `properties` (DEFECT-2) — forwarded verbatim into the Responses
// `text.format.json_schema`. Kept in sync with matcher-runtime.ts.
const MATCHER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["matches", "confidence", "rationale"],
  properties: {
    matches: { type: "boolean" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    rationale: { type: "string" },
  },
} as const;

// Opt-in gate: the explicit smoke flag + a real OpenAI key in the environment.
const LIVE =
  process.env.CINATRA_LIVE_LLM_SMOKE === "1" && !!process.env.OPENAI_API_KEY;

describe.skipIf(!LIVE)(
  "LIVE OpenAI matcher classification round-trip (cinatra#1891 DEFECT-2 + DEFECT-3)",
  () => {
    it("uploads a text/markdown artifact with a synthesized filename → valid {matches,confidence,rationale} 200", async () => {
      const connection: { apiKey: string; defaultModel?: string } = {
        apiKey: process.env.OPENAI_API_KEY!,
      };
      if (process.env.CINATRA_LIVE_LLM_MODEL) {
        connection.defaultModel = process.env.CINATRA_LIVE_LLM_MODEL;
      }
      const adapter = createOpenAIProviderAdapter(connection);

      const markdown = [
        "# Q3 Marketing Strategy",
        "",
        "## Positioning",
        "We position the product as the fastest way for RevOps teams to unify",
        "pipeline data and act on it.",
        "## GTM motion",
        "Product-led growth funnel with a sales-assist tier for enterprise.",
        "## Channel mix",
        "Paid search, lifecycle email, and partner co-marketing.",
        "## Messaging architecture",
        "One core promise, three proof pillars, per-segment value props.",
      ].join("\n");
      const bytes = new TextEncoder().encode(markdown);

      // Mirror the matcher DEFECT-3 fix: synthesize a recognized-extension
      // filename from the authoritative mime (no persisted upload filename here).
      const filename = `live-smoke-artifact${extensionForIngestibleMime("text/markdown")}`;
      expect(filenameExtensionMatchesMime(filename, "text/markdown")).toBe(true);

      // 1) Upload — the exact call that 400'd pre-fix with an extensionless name
      //    ("Expected context stuffing file type … but got none").
      const fileRef = await adapter.uploadFile!({
        content: bytes,
        filename,
        mimeType: "text/markdown",
      });
      expect(fileRef.provider).toBe("openai");
      expect(typeof fileRef.id).toBe("string");

      try {
        // 2) Classify — input_file + the strict matcher output schema (DEFECT-2).
        //    A 400 on EITHER live contract throws here.
        const res = await adapter.generateWithFileInput!({
          system:
            "You classify whether an attached document is a marketing-strategy work product. Respond ONLY with the required JSON.",
          prompt:
            'Classify the attached artifact. Decide whether it is a "marketing-strategy" work product. Respond ONLY with JSON: {"matches": boolean, "confidence": number between 0 and 1, "rationale": short string}.',
          fileId: fileRef.id,
          outputSchema: MATCHER_OUTPUT_SCHEMA as unknown as Record<
            string,
            unknown
          >,
          logLabel: "matcher-live-smoke",
        });

        // 200 with parseable, schema-valid JSON — both live contracts satisfied.
        expect(res.text).toBeTruthy();
        const parsed = JSON.parse(res.text!) as {
          matches: unknown;
          confidence: unknown;
          rationale: unknown;
        };
        expect(typeof parsed.matches).toBe("boolean");
        expect(typeof parsed.confidence).toBe("number");
        expect(parsed.confidence as number).toBeGreaterThanOrEqual(0);
        expect(parsed.confidence as number).toBeLessThanOrEqual(1);
        expect(typeof parsed.rationale).toBe("string");
        // Genuine marketing-strategy content → a well-behaved classifier matches.
        expect(parsed.matches).toBe(true);
      } finally {
        await adapter.deleteFile?.(fileRef).catch(() => {});
      }
    }, 60_000);
  },
);

/*
 * HOW THE STAGED WALK STACK RUNS THIS (per the cinatra#1891 A3 brief):
 *
 *   # from the worktree root; the OpenAI key comes from the SAME Infisical path
 *   # the walk stack uses (project a53ef220-…, /tenants/ossflywheel):
 *   cd packages/llm
 *   source ../../ops/scripts/lib/infisical-cli.sh
 *   infisical run --projectId a53ef220-91e7-4dbd-9dff-6e6ae3a49b2e --env prod \
 *     --path /tenants/ossflywheel -- \
 *     env CINATRA_LIVE_LLM_SMOKE=1 \
 *     npx vitest run --no-coverage \
 *       src/__tests__/matcher-live-provider.smoke.test.ts
 *
 * `infisical run` injects OPENAI_API_KEY into the child env; the smoke flag opts
 * the describe in. Without CINATRA_LIVE_LLM_SMOKE=1 (CI + every normal run) the
 * whole describe is SKIPPED — no key, no network. Pin the model with
 * CINATRA_LIVE_LLM_MODEL (defaults to the provider/connection default).
 */
