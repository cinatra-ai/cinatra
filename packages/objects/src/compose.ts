import type { AgentIOSpec } from "./agent-io-spec";

// ---------------------------------------------------------------------------
// Composability checks
// ---------------------------------------------------------------------------

/**
 * Returns `true` when at least one of `producer.output[].type` exactly
 * matches one of `consumer.input[].type`. v1 uses exact string matching;
 * subtype / structural matching is deferred.
 */
export function canCompose(producer: AgentIOSpec, consumer: AgentIOSpec): boolean {
  return producer.output.some((out) =>
    consumer.input.some((inp) => inp.type === out.type),
  );
}

/**
 * Returns the list of object type IDs that appear in BOTH `producer.output`
 * and `consumer.input`. Useful for UI surfaces that need to show *what*
 * connects two agents.
 */
export function findCompositionMatches(
  producer: AgentIOSpec,
  consumer: AgentIOSpec,
): string[] {
  const inputs = new Set(consumer.input.map((i) => i.type));
  const matches: string[] = [];
  for (const out of producer.output) {
    if (inputs.has(out.type) && !matches.includes(out.type)) {
      matches.push(out.type);
    }
  }
  return matches;
}
