// Neo4j / Graphiti works-after round-trip (cinatra#352).
//
// Functional proof for a neo4j / graphiti major bump: project ONE synthetic
// episode carrying a unique marker through the repo's OWN
// packages/objects/src/graphiti-client.ts (MCP-over-HTTP: add_memory /
// get_episodes / search_nodes / get_status), then poll get_episodes until the
// projected episode is READ BACK from Neo4j — the real "project -> store ->
// retrieve" round-trip through the bolt driver + the Graphiti store + the MCP
// tool contract. A neo4j-6 / graphiti major that breaks the bolt driver, the
// node write/read, or the MCP tool surface fails here.
//
// IMPORTANT — this arm needs a REAL OpenAI key (settled empirically for
// zepai/knowledge-graph-mcp:1.0.2, cinatra#352 design §1.4/§6.1):
//   * add_memory does entity EXTRACTION (LLM) BEFORE it writes anything to
//     Neo4j. If extraction fails, the episode is NOT written at all — so even
//     get_episodes returns nothing.
//   * The graphiti image's factory (services/factories.py) honors a custom
//     OpenAI base-URL for the EMBEDDER but NOT for the LLM client (it builds the
//     LLM CoreLLMConfig without base_url), and the LLM client targets the OpenAI
//     `/v1/responses` API. So a local OpenAI-compatible fake CANNOT stand in for
//     the LLM — extraction always hits api.openai.com.
// => The Graphiti arm is therefore NOT part of the secret-free always-on PR
//    set; it runs in the major-upgrade LANE / workflow_dispatch with a real
//    OPENAI_API_KEY the lane supplies (and is SKIPPED, not failed, when no key
//    is present outside gate mode). With a real key, extraction succeeds, the
//    episode is written, and BOTH get_episodes AND search_nodes find the marker.
//
// The proof: project ONE synthetic episode carrying a unique marker, then assert
// (a) the episode is READ BACK via get_episodes (bolt driver + node write/read +
// MCP contract) AND (b) the extracted marker entity is found via search_nodes
// (the full index + extraction round-trip). A neo4j-6 / graphiti major that
// breaks the driver, the store, the index, or the MCP tool surface fails here.
//
// REUSES graphiti-client.ts (server-only + MCP SDK + undici), so it MUST run
// with the React Server condition:
//   node --conditions=react-server --import tsx scripts/ci/works-after/rt/graphiti-roundtrip.ts
// (plain tsx throws on the `server-only` import).
//
// Env: GRAPHITI_URL (required), WORKS_AFTER_MARKER (required — the marker name),
//      WORKS_AFTER_DEADLINE_MS (default 120000 — graphiti indexes async/cold).

import { addEpisode, getEpisodes, searchNodes, getStatus } from "../../../../packages/objects/src/graphiti-client.ts";

// GRAPHITI_URL is consumed by graphiti-client.ts itself (getGraphitiUrl reads
// process.env.GRAPHITI_URL); this guard just fails fast with a clear message if
// the arm didn't export it.
if (!process.env.GRAPHITI_URL) {
  console.error("graphiti-roundtrip: GRAPHITI_URL is required");
  process.exit(2);
}
if (!process.env.WORKS_AFTER_MARKER) {
  console.error("graphiti-roundtrip: WORKS_AFTER_MARKER is required");
  process.exit(2);
}
// Narrowed to `string` after the guard above (env reads are string | undefined).
const MARKER: string = process.env.WORKS_AFTER_MARKER;
const DEADLINE_MS = Number(process.env.WORKS_AFTER_DEADLINE_MS ?? "120000");
const GROUP_ID = `works-after-${Date.now()}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitConnected(): Promise<void> {
  const deadline = Date.now() + 60_000;
  let last = "";
  while (Date.now() < deadline) {
    const s = await getStatus();
    last = s.detail;
    if (s.status === "connected") {
      console.log(`graphiti-roundtrip: ${s.detail}`);
      return;
    }
    await sleep(3000);
  }
  throw new Error(`graphiti get_status never reached 'connected' within 60s (last: ${last})`);
}

async function main(): Promise<void> {
  await waitConnected();

  // Project ONE episode whose body carries the unique marker. The episode is
  // written to Neo4j by graphiti WITHOUT needing LLM extraction.
  const episodeName = `works-after-episode-${MARKER}`;
  const episodeBody = JSON.stringify({
    name: MARKER,
    type: "Marker",
    note: `works-after proof marker ${MARKER}`,
  });
  await addEpisode({
    name: episodeName,
    episode_body: episodeBody,
    source: "json",
    source_description: "works-after proof",
    group_id: GROUP_ID,
  });
  console.log(`graphiti-roundtrip: projected episode '${episodeName}' (group ${GROUP_ID})`);

  // REQUIRED 1: poll get_episodes until the projected episode is read back from
  // Neo4j. add_memory is queued + extraction-gated, so this is a bounded poll;
  // a 401/extraction failure (e.g. a missing/invalid OPENAI_API_KEY) means the
  // episode is never written and this assertion fails loud — which is the point.
  const deadline = Date.now() + DEADLINE_MS;
  let attempts = 0;
  let lastErr = "";
  let episodeBack = false;
  while (Date.now() < deadline && !episodeBack) {
    attempts++;
    try {
      const res = await getEpisodes({ group_ids: [GROUP_ID], max_episodes: 50 });
      if (res.episodes.some((e) => e.name === episodeName)) {
        episodeBack = true;
        console.log(
          `graphiti-roundtrip: episode '${episodeName}' READ BACK from neo4j via get_episodes after ${attempts} poll(s) (${res.episodes.length} in group)`,
        );
        break;
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await sleep(5000);
  }
  if (!episodeBack) {
    throw new Error(
      `episode '${episodeName}' did not become retrievable within ${DEADLINE_MS}ms (${attempts} polls) — the project->store->retrieve round-trip through neo4j/graphiti did not complete. A common cause is failed entity extraction (missing/invalid OPENAI_API_KEY) which aborts the episode write.${lastErr ? ` Last error: ${lastErr}` : ""}`,
    );
  }

  // REQUIRED 2: the extracted marker entity must be searchable. With a real LLM
  // key (the lane's), extraction lifts the marker into an :Entity node; this is
  // the full index + extraction round-trip a graphiti major can break.
  const searchDeadline = Date.now() + DEADLINE_MS;
  let searchAttempts = 0;
  while (Date.now() < searchDeadline) {
    searchAttempts++;
    try {
      const s = await searchNodes({ query: MARKER, group_ids: [GROUP_ID], max_nodes: 20 });
      if (s.nodes.some((n) => n.name === MARKER || n.name.includes(MARKER))) {
        console.log(
          `graphiti-roundtrip OK — episode read back AND marker entity '${MARKER}' found via search_nodes after ${searchAttempts} poll(s) (${s.nodes.length} node(s)). Full project->store->extract->search round-trip through neo4j/graphiti verified.`,
        );
        return;
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await sleep(5000);
  }
  throw new Error(
    `marker entity '${MARKER}' did not become searchable within ${DEADLINE_MS}ms (${searchAttempts} polls) — the episode was stored but entity extraction/indexing did not surface the marker (check the LLM provider + key).${lastErr ? ` Last error: ${lastErr}` : ""}`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`graphiti-roundtrip FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
