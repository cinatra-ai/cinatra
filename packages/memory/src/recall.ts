/**
 * Local recall: plain lexical scoring over the loaded bundle. No LLM, no
 * network, no index service — this is the offline CLI-side counterpart of
 * the server-side semantic recall that lives elsewhere in the epic.
 */
import type { MemoryConcept } from "./types.ts";

/** One recall hit. */
export interface MemoryRecallMatch {
  concept: MemoryConcept;
  /** Lexical relevance score (higher is better). */
  score: number;
  /** First body line containing a query term, if any. */
  snippet?: string;
}

/** Options accepted by {@link recallMemoryConcepts}. */
export interface RecallMemoryOptions {
  /** Maximum matches returned (default 10). */
  limit?: number;
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t !== "");
}

function countOccurrences(tokens: readonly string[], term: string): number {
  let count = 0;
  for (const token of tokens) if (token === term) count += 1;
  return count;
}

/**
 * Rank concepts against a free-text query. Field weights: title 5, tags 4,
 * description 3, type 2, body 1 per term occurrence. Ties break by path so
 * results are deterministic.
 */
export function recallMemoryConcepts(
  concepts: readonly MemoryConcept[],
  query: string,
  options: RecallMemoryOptions = {},
): MemoryRecallMatch[] {
  const limit = options.limit ?? 10;
  const terms = [...new Set(tokenize(query))];
  if (terms.length === 0) return [];

  const matches: MemoryRecallMatch[] = [];
  for (const concept of concepts) {
    const titleTokens = tokenize(concept.title ?? "");
    const descriptionTokens = tokenize(concept.description ?? "");
    const typeTokens = tokenize(concept.type);
    const tagTokens = concept.tags.flatMap(tokenize);
    const bodyTokens = tokenize(concept.body);
    let score = 0;
    for (const term of terms) {
      score += countOccurrences(titleTokens, term) * 5;
      score += countOccurrences(tagTokens, term) * 4;
      score += countOccurrences(descriptionTokens, term) * 3;
      score += countOccurrences(typeTokens, term) * 2;
      score += countOccurrences(bodyTokens, term);
    }
    if (score <= 0) continue;
    let snippet: string | undefined;
    for (const line of concept.body.split("\n")) {
      const lower = line.toLowerCase();
      if (terms.some((t) => lower.includes(t))) {
        snippet = line.trim().slice(0, 200);
        break;
      }
    }
    matches.push({
      concept,
      score,
      ...(snippet === undefined ? {} : { snippet }),
    });
  }
  matches.sort((a, b) =>
    b.score !== a.score
      ? b.score - a.score
      : a.concept.path < b.concept.path
        ? -1
        : 1,
  );
  return matches.slice(0, limit);
}
