/**
 * Provider-neutral structured-JSON extraction for LLM text output.
 *
 * Relocated VERBATIM from the openai connector (cinatra#151 Stage 2, design
 * round ruling): the function is pure text parsing with no provider state and
 * is used against output from EVERY provider (openai/anthropic/gemini), so it
 * lives in this provider-neutral layer instead of coupling all structured
 * parsing to the openai connector's presence. Tries, in order: the raw text,
 * a ```json fenced block, any fenced block, and the outermost {...} slice.
 */
export function parseStructuredJson<T>(rawText: string): T | null {
  const candidates = [
    rawText.trim(),
    rawText.match(/```json\s*([\s\S]*?)```/i)?.[1]?.trim(),
    rawText.match(/```([\s\S]*?)```/i)?.[1]?.trim(),
    rawText.includes("{") && rawText.includes("}")
      ? rawText.slice(rawText.indexOf("{"), rawText.lastIndexOf("}") + 1).trim()
      : undefined,
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      continue;
    }
  }

  return null;
}
