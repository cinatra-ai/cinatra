import { z } from "zod";

// ---------------------------------------------------------------------------
// MCP tool inputs — passed as { name, arguments } to client.callTool()
// Tool names and params verified against zepai/knowledge-graph-mcp:1.0.2-graphiti-0.28.2
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

export type EpisodeNode = z.infer<typeof episodeNodeSchema>;
export type EntityNode = z.infer<typeof entityNodeSchema>;
export type AddEpisodeResult = z.infer<typeof addEpisodeResultSchema>;
export type SearchNodesResult = z.infer<typeof searchNodesResultSchema>;
export type GetEpisodesResult = z.infer<typeof getEpisodesResultSchema>;
