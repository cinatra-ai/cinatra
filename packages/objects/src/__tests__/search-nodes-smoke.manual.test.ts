// Manual smoke test for Graphiti search_nodes object ID preservation.
//
// This test is gated behind the RUN_GRAPHITI_SMOKE=1 env var. It requires:
//   - Docker Graphiti container running and reachable via the configured URL
//   - Neo4j backing store running
//   - Network connectivity to Graphiti's MCP HTTP transport
//
// In sandboxed executor environments, those services are not available. The
// test therefore:
//   1. Documents the exact procedure operators must follow when validating
//      the cinatra_object_id field path before relying on `extractObjectIds`.
//   2. Probes multiple field paths so the operator can pick the right one
//      (node.attributes.cinatra_object_id, top-level, name-contains, ...).
//
// See `extractObjectIds` in `packages/objects/src/mcp/handlers.ts` — the
// implementation deliberately reads BOTH `node.attributes.cinatra_object_id`
// (the most likely path) AND the top-level `node.cinatra_object_id` (fallback
// if Graphiti's LLM extractor flattens fields) so the read path stays correct
// regardless of which path the live smoke test confirms.
//
// To run manually:
//   docker compose up -d graphiti neo4j   # in your dev compose
//   RUN_GRAPHITI_SMOKE=1 pnpm --filter @cinatra-ai/objects test --run \
//     -t "search_nodes preserves cinatra_object_id"
//
// Inspect the console output:
//   [smoke] addEpisode response: ...
//   [smoke] searchNodes RAW results: ...
//   [smoke] objectId field-path probes: { ... }
//
// The probe map tells you which field path actually carries the objectId
// after Graphiti's LLM-driven entity extraction. If a different path wins,
// adjust `extractObjectIds` accordingly.

import { describe, it, expect, vi } from "vitest";

// graphiti-client.ts (transitively) imports `server-only`, which throws
// when imported from a non-Server-Component module. Stub it out so the
// suite collector can load this file even when the test itself is skipped
// (RUN_GRAPHITI_SMOKE != "1"). This mock is harmless when the smoke test
// actually runs — graphiti-client uses no exports from `server-only`.
vi.mock("server-only", () => ({}));

import { addEpisode, searchNodes, deleteEpisode } from "../graphiti-client";

const SHOULD_RUN = process.env.RUN_GRAPHITI_SMOKE === "1";

describe.runIf(SHOULD_RUN)(
  "search_nodes preserves cinatra_object_id",
  () => {
    it("returns a field path that carries cinatra_object_id after entity extraction", async () => {
      const objectId = `smoke-${Date.now()}`;
      const groupId = "cinatra-smoke-test";

      const episode = await addEpisode({
        name: `Smoke entity ${objectId}`,
        episode_body: JSON.stringify({
          name: "Acme Smoke Corp",
          industry: "Testing",
          // Top-level field path for Graphiti entity extraction.
          cinatra_object_id: objectId,
          // Legacy meta used by the handlers.ts back-compat path.
          _cinatra: { objectId, version: 1, type: "company" },
        }),
        source: "json",
        source_description: "object-id smoke test",
        group_id: groupId,
      });
      console.log("[smoke] addEpisode response:", JSON.stringify(episode, null, 2));

      // Wait for indexing — Graphiti is async.
      await new Promise((r) => setTimeout(r, 5000));

      const result = await searchNodes({
        query: "Acme Smoke Corp",
        group_ids: [groupId],
        max_nodes: 5,
      });
      console.log("[smoke] searchNodes RAW results:", JSON.stringify(result, null, 2));

      const nodes = result.nodes;
      expect(nodes.length).toBeGreaterThan(0);

      // Probe possible field paths for the objectId. The console output is
      // the operator-facing validation artifact.
      const node = nodes[0] as Record<string, unknown>;
      const attrs = (node.attributes ?? {}) as Record<string, unknown>;
      const candidates: Record<string, unknown> = {
        "node.attributes.cinatra_object_id": attrs.cinatra_object_id,
        "node.cinatra_object_id": (node as { cinatra_object_id?: unknown }).cinatra_object_id,
        "node.attributes.cinatraObjectId": attrs.cinatraObjectId,
        "node.summary contains objectId":
          typeof node.summary === "string" && (node.summary as string).includes(objectId),
        "node.name contains objectId":
          typeof node.name === "string" && (node.name as string).includes(objectId),
      };
      console.log("[smoke] objectId field-path probes:", candidates);

      const found = Object.entries(candidates).filter(([_, v]) => Boolean(v));
      expect(found.length).toBeGreaterThan(0);

      // Cleanup — delete the smoke episode by uuid.
      const epUuid =
        (episode as { uuid?: string }).uuid ??
        (episode as { episode?: { uuid?: string } }).episode?.uuid ??
        "";
      if (epUuid) {
        await deleteEpisode({ uuid: epUuid });
      }
    }, 30_000);
  },
);
