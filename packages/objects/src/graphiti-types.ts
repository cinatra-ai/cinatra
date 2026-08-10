import { z } from "zod";

// ---------------------------------------------------------------------------
// MCP tool inputs — passed as { name, arguments } to client.callTool()
//
// Tool names and params verified on the wire (2026-08-10, cinatra#2591) against
// the peer this repo now runs: UPSTREAM getzep/graphiti's own MCP server, built
// by docker/graphiti/Dockerfile. `tools/list` on that peer returns 13 tools:
//
//   add_memory, add_triplet, build_communities, clear_graph, delete_entity_edge,
//   delete_episode, get_entity_edge, get_episode_entities, get_episodes,
//   get_status, search_memory_facts, search_nodes, summarize_saga
//
// `add_triplet` and `get_episode_entities` are NEW relative to the previously
// pinned zepai/knowledge-graph-mcp:1.0.2-graphiti-0.28.2 wrapper, and
// `add_triplet` is what deterministic row recovery is built on.
// ---------------------------------------------------------------------------

// Tool name: "add_memory" (not "add_episode" in this image version)
export const addEpisodeInputSchema = z.object({
  name: z.string(),
  episode_body: z.string(),
  source: z.enum(["json", "text", "message"]).default("json"),
  source_description: z.string().optional(),
  group_id: z.string(),
  uuid: z.string().optional(),
  reference_time: z.string().optional(),
});

// Tool name: "search_nodes" — num_results param is max_nodes in this version
export const searchNodesInputSchema = z.object({
  query: z.string(),
  group_ids: z.array(z.string()).optional(),
  max_nodes: z.number().int().min(1).max(500).optional(),
});

// Tool name: "get_episodes" — takes group_ids (array) + max_episodes
export const getEpisodesInputSchema = z.object({
  group_ids: z.array(z.string()),
  max_episodes: z.number().int().min(1).max(2000).optional(),
});

export const deleteEpisodeInputSchema = z.object({
  uuid: z.string(),
});

// Tool name: "clear_graph" — takes group_ids (array)
export const clearGraphInputSchema = z.object({
  group_ids: z.array(z.string()),
});

// Tool name: "add_triplet" — writes ONE (source)-[edge]->(target) directly,
// BYPASSING episode extraction (cinatra#2591 deterministic row recovery).
//
// The load-bearing parameter is `source_node_uuid`: the caller chooses the
// entity node's UUID. graphiti-core looks that UUID up first
// (`EntityNode.get_by_uuid`) and only falls through to name-based dedup when it
// does not exist, so a repeat write with the same UUID is an UPSERT of the same
// node rather than a second one. Measured on the wire 2026-08-10: the chosen
// UUID came back verbatim, and a second call with the same UUID left exactly
// one node carrying that name.
//
// The write needs the EMBEDDER (graphiti embeds the node name and the edge
// fact) but NOT the LLM — which is what makes an install with no extraction
// provider still able to seed and rank rows.
export const addTripletInputSchema = z.object({
  source_node_name: z.string(),
  edge_name: z.string(),
  fact: z.string(),
  target_node_name: z.string(),
  group_id: z.string(),
  source_node_uuid: z.string().optional(),
  target_node_uuid: z.string().optional(),
});

// Tool name: "get_episode_entities" — episode -> the nodes/edges it produced.
// Provenance in the forward direction; used to attribute extracted entities
// back to the episode (and therefore the row) that produced them.
export const getEpisodeEntitiesInputSchema = z.object({
  episode_uuids: z.array(z.string()).min(1),
});

// ---------------------------------------------------------------------------
// MCP tool outputs — parsed from the JSON text content returned by callTool()
// ---------------------------------------------------------------------------

export const episodeNodeSchema = z.object({
  uuid: z.string(),
  name: z.string(),
  content: z.string(),
  group_id: z.string().optional(),
  created_at: z.string().optional(),
  source: z.string().optional(),
  source_description: z.string().optional(),
}).passthrough();

export const entityNodeSchema = z.object({
  uuid: z.string(),
  name: z.string(),
  summary: z.string().optional(),
  labels: z.array(z.string()).optional(),
  group_id: z.string().optional(),
}).passthrough();

export const addEpisodeResultSchema = z.object({
  episode_id: z.string().optional(),
  episode: episodeNodeSchema.optional(),
  message: z.string().optional(),
}).passthrough();

export const searchNodesResultSchema = z.object({
  nodes: z.array(entityNodeSchema),
});

export const getEpisodesResultSchema = z.object({
  episodes: z.array(episodeNodeSchema),
});

export const entityEdgeSchema = z.object({
  uuid: z.string(),
  name: z.string().optional(),
  fact: z.string().optional(),
  source_node_uuid: z.string().optional(),
  target_node_uuid: z.string().optional(),
  group_id: z.string().optional(),
}).passthrough();

// `add_triplet` answers with the RESOLVED nodes — which is why the caller must
// read the UUID back rather than assume the one it sent survived. It normally
// does (measured), but graphiti-core may resolve a brand-new node onto an
// existing near-duplicate, and in that case the resolved UUID is the truth.
export const addTripletResultSchema = z.object({
  message: z.string().optional(),
  nodes: z.array(entityNodeSchema).default([]),
  edges: z.array(entityEdgeSchema).default([]),
}).passthrough();

export const getEpisodeEntitiesResultSchema = z.object({
  message: z.string().optional(),
  nodes: z.array(entityNodeSchema).default([]),
  edges: z.array(entityEdgeSchema).default([]),
}).passthrough();

export const graphitiStatusSchema = z.object({
  status: z.string(),
}).passthrough();

// ---------------------------------------------------------------------------
// TypeScript types
// ---------------------------------------------------------------------------

export type AddEpisodeInput = z.infer<typeof addEpisodeInputSchema>;
export type SearchNodesInput = z.infer<typeof searchNodesInputSchema>;
export type GetEpisodesInput = z.infer<typeof getEpisodesInputSchema>;
export type DeleteEpisodeInput = z.infer<typeof deleteEpisodeInputSchema>;
export type ClearGraphInput = z.infer<typeof clearGraphInputSchema>;
export type AddTripletInput = z.infer<typeof addTripletInputSchema>;
export type GetEpisodeEntitiesInput = z.infer<typeof getEpisodeEntitiesInputSchema>;

export type EpisodeNode = z.infer<typeof episodeNodeSchema>;
export type EntityNode = z.infer<typeof entityNodeSchema>;
export type EntityEdge = z.infer<typeof entityEdgeSchema>;
export type AddEpisodeResult = z.infer<typeof addEpisodeResultSchema>;
export type SearchNodesResult = z.infer<typeof searchNodesResultSchema>;
export type GetEpisodesResult = z.infer<typeof getEpisodesResultSchema>;
export type AddTripletResult = z.infer<typeof addTripletResultSchema>;
export type GetEpisodeEntitiesResult = z.infer<typeof getEpisodeEntitiesResultSchema>;
