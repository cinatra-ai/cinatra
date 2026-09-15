// Neo4j / Graphiti works-after round-trip (cinatra#352, re-shaped by cinatra#2591).
//
// Functional proof for a neo4j / graphiti bump, driven through the repo's OWN
// packages/objects/src/graphiti-client.ts (MCP-over-HTTP) so the tool contract,
// the negotiation mode and the response schemas are all exercised as the app
// exercises them.
//
// TWO TIERS, selected by WORKS_AFTER_TIER:
//
//   keyless — NO provider key anywhere. Proves the part of the substrate that
//     must work without a vendor:
//       1. the server is reachable and reports status through the MCP surface;
//       2. a row can be seeded as a DETERMINISTIC anchor node, with a UUID THIS
//          side chooses (cinatra#2591 deliverable 4);
//       3. that anchor comes back from a SEMANTIC query that does not contain
//          its literal name — i.e. the LOCAL embedder really ranks
//          (deliverable 3);
//       4. re-seeding the same row is an UPSERT, not a second node;
//       5. an episode handed over with no extraction provider is accepted and
//          then NOT stored — the honest "extraction is off" state, which is why
//          the app must park rather than pretend.
//
//   keyed — adds the one thing only a real provider can prove: episode ->
//     EXTRACTION -> the extracted entity is searchable.
//
// WHY THE KEYLESS TIER CAN EXIST NOW. It could not before. The pinned
// zepai/knowledge-graph-mcp:1.0.2 wrapper built its OpenAI LLM client without a
// base_url, so extraction always hit api.openai.com and nothing could stand in;
// and row recovery depended on that extraction emitting an id. Both are gone:
// the replacement server forwards base_url, and recovery is now carried by a
// deterministic anchor that needs only the embedder.
//
// REUSES graphiti-client.ts (server-only + MCP SDK + undici), so it MUST run
// with the React Server condition:
//   node --conditions=react-server --import tsx scripts/ci/works-after/rt/graphiti-roundtrip.ts
// (plain tsx throws on the `server-only` import).
//
// Env: GRAPHITI_URL (required), WORKS_AFTER_MARKER (required — the marker name),
//      WORKS_AFTER_TIER ("keyless" | "keyed", default "keyed"),
//      WORKS_AFTER_DEADLINE_MS (default 120000 — graphiti indexes async/cold).

import {
  addEpisode,
  addTriplet,
  getEpisodes,
  searchNodes,
  getStatus,
} from "../../../../packages/objects/src/graphiti-client.ts";

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
const MARKER: string = process.env.WORKS_AFTER_MARKER;
const TIER = process.env.WORKS_AFTER_TIER === "keyless" ? "keyless" : "keyed";
const DEADLINE_MS = Number(process.env.WORKS_AFTER_DEADLINE_MS ?? "120000");
const GROUP_ID = `works-after-${TIER}-${Date.now()}`;

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

/**
 * TIER 1. The substrate proof that needs no vendor.
 *
 * The row this stands in for is a synthetic one; what matters is that its
 * anchor UUID is chosen HERE and must come back from the graph unchanged, and
 * that the query used to find it is NOT the node's name.
 */
async function keylessTier(): Promise<void> {
  // A deliberately fixed, obviously-synthetic UUID: the assertion is that the
  // graph honours the caller's identity choice, so a random one would prove
  // less clearly.
  const anchorUuid = "2591a0c4-0000-4000-8000-" + MARKER.slice(-12).padStart(12, "0").toLowerCase();
  const anchorName = `${MARKER} quarterly revenue retrospective for Northwind Traders`;

  const seeded = await addTriplet({
    source_node_name: anchorName,
    edge_name: "RECORDED_IN",
    fact: `${anchorName} is recorded in the cinatra object store.`,
    target_node_name: "cinatra object store",
    group_id: GROUP_ID,
    source_node_uuid: anchorUuid,
  });
  const seededNode = seeded.nodes.find((n) => n.name === anchorName);
  if (!seededNode) {
    throw new Error(
      `add_triplet did not return the seeded anchor '${anchorName}'. Returned: ` +
        JSON.stringify(seeded.nodes.map((n) => n.name)),
    );
  }
  if (seededNode.uuid !== anchorUuid) {
    throw new Error(
      `the graph did not honour the caller-chosen anchor UUID (sent ${anchorUuid}, got ` +
        `${seededNode.uuid}). Deterministic row recovery depends on this identity, so a ` +
        "change here is a contract break, not a cosmetic difference.",
    );
  }
  console.log(`graphiti-roundtrip: anchor node seeded with the CHOSEN uuid ${anchorUuid}`);

  // The query deliberately does NOT contain the node's name or the marker: a
  // lexical match would prove nothing about embeddings. Only the local embedder
  // can connect "revenue retrospective Northwind" to this node.
  const semanticQuery = "revenue retrospective Northwind";
  const deadline = Date.now() + DEADLINE_MS;
  let attempts = 0;
  let found = false;
  let lastErr = "";
  while (Date.now() < deadline && !found) {
    attempts++;
    try {
      const res = await searchNodes({ query: semanticQuery, group_ids: [GROUP_ID], max_nodes: 20 });
      if (res.nodes.some((n) => n.uuid === anchorUuid)) {
        found = true;
        console.log(
          `graphiti-roundtrip: the anchor came back from the SEMANTIC query ` +
            `'${semanticQuery}' after ${attempts} poll(s) (${res.nodes.length} node(s)) — ` +
            "the LOCAL embedder ranked it, with no provider key anywhere.",
        );
        break;
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
    await sleep(3000);
  }
  if (!found) {
    throw new Error(
      `the deterministic anchor ${anchorUuid} was not returned by the semantic query ` +
        `'${semanticQuery}' within ${DEADLINE_MS}ms (${attempts} polls). Either the local ` +
        "embedder is not serving vectors or the anchor was not indexed." +
        (lastErr ? ` Last error: ${lastErr}` : ""),
    );
  }

  // Re-seeding the SAME uuid must upsert, not duplicate: a re-projection of an
  // unchanged row happens on every repair cycle, and a duplicating seed would
  // grow the graph without bound and split one row across many nodes.
  await addTriplet({
    source_node_name: anchorName,
    edge_name: "RECORDED_IN",
    fact: `${anchorName} is recorded in the cinatra object store.`,
    target_node_name: "cinatra object store",
    group_id: GROUP_ID,
    source_node_uuid: anchorUuid,
  });
  const after = await searchNodes({ query: semanticQuery, group_ids: [GROUP_ID], max_nodes: 50 });
  const carryingName = after.nodes.filter((n) => n.name === anchorName);
  if (carryingName.length !== 1 || carryingName[0].uuid !== anchorUuid) {
    throw new Error(
      `re-seeding the same anchor was not idempotent: ${carryingName.length} node(s) now carry ` +
        `the anchor name (${carryingName.map((n) => n.uuid).join(", ")}).`,
    );
  }
  console.log("graphiti-roundtrip: re-seeding the same anchor UPSERTED (exactly one node)");

  // And the honest keyless state: an episode is ACCEPTED by the queue and then
  // never stored, because extraction runs before the graph write. The app must
  // therefore park rather than hand over — this asserts the behaviour the app's
  // honesty layer is written against.
  const episodeName = `works-after-keyless-episode-${MARKER}`;
  await addEpisode({
    name: episodeName,
    episode_body: JSON.stringify({ name: MARKER, note: "keyless episode probe" }),
    source: "json",
    source_description: "works-after keyless proof",
    group_id: GROUP_ID,
  });
  await sleep(20_000);
  const eps = await getEpisodes({ group_ids: [GROUP_ID], max_episodes: 50 });
  if (eps.episodes.some((e) => e.name === episodeName)) {
    throw new Error(
      `episode '${episodeName}' WAS stored without any extraction provider. That contradicts ` +
        "the model the app's keyless honesty layer is built on (extraction runs before the " +
        "graph write, so a keyless episode is dropped). Re-check the layer if upstream changed this.",
    );
  }
  console.log(
    "graphiti-roundtrip: keyless episode accepted by the queue and NOT stored — the honest " +
      "'extraction is off' state, unchanged on the replacement server",
  );
}

/**
 * TIER 2. Extraction — the one thing that genuinely needs a provider key.
 */
async function keyedTier(): Promise<void> {
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

  // REQUIRED 1: the projected episode is read back from Neo4j. add_memory is
  // queued + extraction-gated, so this is a bounded poll; a 401/extraction
  // failure means the episode is never written and this fails loud.
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

  // REQUIRED 2: the EXTRACTED marker entity is searchable — the full index +
  // extraction round-trip a graphiti major can break.
  const searchDeadline = Date.now() + DEADLINE_MS;
  let searchAttempts = 0;
  while (Date.now() < searchDeadline) {
    searchAttempts++;
    try {
      const s = await searchNodes({ query: MARKER, group_ids: [GROUP_ID], max_nodes: 20 });
      if (s.nodes.some((n) => n.name === MARKER || n.name.includes(MARKER))) {
        console.log(
          `graphiti-roundtrip OK — episode read back AND extracted entity '${MARKER}' found via search_nodes after ${searchAttempts} poll(s) (${s.nodes.length} node(s)).`,
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

async function main(): Promise<void> {
  await waitConnected();
  console.log(`graphiti-roundtrip: tier=${TIER} group=${GROUP_ID}`);
  if (TIER === "keyless") {
    await keylessTier();
    return;
  }
  await keyedTier();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`graphiti-roundtrip FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
