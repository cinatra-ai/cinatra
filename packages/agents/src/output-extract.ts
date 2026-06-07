/**
 * Extract the last balanced JSON object from LLM output text.
 *
 * LLM responses often mix prose with a trailing JSON block. JSON.parse() fails
 * on any leading/trailing non-JSON text. This utility walks backwards through
 * all '}' positions and for each candidate finds the matching '{' by tracking
 * brace depth, then attempts JSON.parse on that slice — exactly like Python's
 * _extract_trailing_json in packages/langgraph-agents/graphs/leaf_v1.py.
 *
 * Any HITL renderer that reads fetchChildInterruptOutput() output should import
 * and use this instead of calling JSON.parse() directly.
 *
 * Returns null when no balanced {...} can be parsed from the text.
 */
export function extractJsonFromText(text: string): Record<string, unknown> | null {
  // Fast path: pure JSON string (most LLM outputs when the prompt enforces it)
  try { return JSON.parse(text) as Record<string, unknown>; } catch {}
  // Walk backwards through all '}' positions; for each candidate find the
  // matching '{' by tracking brace depth, then try to parse that slice.
  const closes: number[] = [];
  for (let i = 0; i < text.length; i++) { if (text[i] === "}") closes.push(i); }
  for (let k = closes.length - 1; k >= 0; k--) {
    let depth = 0;
    for (let i = closes[k]; i >= 0; i--) {
      if (text[i] === "}") depth++;
      else if (text[i] === "{") {
        if (--depth === 0) {
          try { return JSON.parse(text.slice(i, closes[k] + 1)) as Record<string, unknown>; }
          catch { break; }
        }
      }
    }
  }
  return null;
}
