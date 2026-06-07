/**
 * Allowlist for documented OAS-RUNTIME findings — CURRENTLY EMPTY.
 *
 * This map encodes any "runtime-backed-agent" design exception, where a
 * context-using agent declares a `contextRefs` EndNode output with NO
 * flow-graph producer, so each inlined context subflow inherently trips one
 * `OAS-RUNTIME-005` AND WayFlow's pyagentspec loader rejects the agent at
 * mount (`ValueError: the flow requires the input descriptor contextRefs`).
 *
 * All six affected agents are repaired at the OAS level — NOT by
 * weakening the validator or these tests:
 *   - context-selection-agent: `contextRefs` now has a real flow-graph
 *     producer — a DataFlowEdge `start.contextRefs -> end.contextRefs`
 *     (the StartNode produces it), so it is no longer producer-less.
 *   - blog idea/draft/image + email-outreach: the byte-faithful inlined
 *     context subflow was removed and replaced with a flow-wired
 *     `contextSlotBindings` hidden StartNode input (data/control edge counts
 *     dropped accordingly — e.g. blog-draft-writer 15->11 DFE, 3->2 CFE).
 *   - blog-pipeline: inherits the children's fix — its 3 nested findings clear.
 * All six now both MOUNT in WayFlow's pyagentspec loader (verified live) and
 * produce zero validator findings, so this map is empty.
 * `oas-runtime-invariants.test.ts` enforces that any resolved entry is deleted
 * (anti-rot), so re-adding a stale entry for a now-clean agent fails CI.
 *
 * Consumed by:
 *   - oas-runtime-invariants.test.ts (positive-case sweep)
 *   - agent-source-review-parity.test.ts (per-agent validateOasAgentJson)
 *   - blog-*-agent-validates.test.ts (per-agent validateOasAgentJson)
 */
import { expect } from "vitest";
import type { ReviewFinding } from "../../validate-agent-json";

export type AllowlistEntry = {
  phase: string;
  expectedCodes: string[];
  expectedBlockerCount: number;
  /**
   * Identity-pinning substrings — each MUST appear in some allowed finding's
   * message/location. Prevents masking: a different OAS-RUNTIME-005 elsewhere
   * with the same code + count would no longer pass silently.
   */
  expectedLocations: string[];
  reason: string;
};

export const KNOWN_BROKEN_AGENTS: Record<string, AllowlistEntry> = {};

/**
 * Asserts that structured `findings` for `slug` match the documented
 * allowlist (codes + count), or are empty if no allowlist entry exists.
 * Codes are compared as a deduped sorted set so any NEW code surfacing
 * through the allowlist fails loudly rather than being silently masked.
 * Use this from callers like `scanOasForRuntimeInvariantFindings` that
 * return `ReviewFinding[]`.
 */
export function expectFindingsMatchAllowlist(
  slug: string,
  findings: ReviewFinding[],
): void {
  const entry = KNOWN_BROKEN_AGENTS[slug];
  if (!entry) {
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
    return;
  }
  const actualCodes = [...new Set(findings.map((f) => f.code))].sort();
  const expectedCodes = [...entry.expectedCodes].sort();
  expect(
    actualCodes,
    `Allowlist code drift for ${slug}: expected ${JSON.stringify(expectedCodes)}, got ${JSON.stringify(actualCodes)}. Findings: ${JSON.stringify(findings, null, 2)}`,
  ).toEqual(expectedCodes);
  expect(
    findings,
    `Allowlist count drift for ${slug}: expected ${entry.expectedBlockerCount}, got ${findings.length}. Findings: ${JSON.stringify(findings, null, 2)}`,
  ).toHaveLength(entry.expectedBlockerCount);
  // Identity pin: every expected location/identity substring must appear in
  // at least one finding's location or message. Prevents same-code/same-count
  // masking of an unrelated finding elsewhere in the OAS.
  const blob = findings
    .map((f) => `${String(f.location ?? "")} ${f.message}`)
    .join("\n");
  for (const loc of entry.expectedLocations) {
    expect(
      blob.includes(loc),
      `Allowlist location pin missed for ${slug}: expected substring ${JSON.stringify(loc)} in some finding. Findings: ${JSON.stringify(findings, null, 2)}`,
    ).toBe(true);
  }
}

/**
 * String-message variant for callers like `validateOasAgentJson` that return
 * formatted error strings (each prefixed with the structural code, e.g.
 * "OAS-RUNTIME-005 at $referenced_components..."). Extracts the leading
 * `<CATEGORY>-<NAME>-<NUM>` token and applies the same allowlist invariants.
 */
const ERROR_CODE_PREFIX_RE = /^[A-Z]+(?:-[A-Z]+)+-\d+/;
export function expectMessagesMatchAllowlist(
  slug: string,
  messages: string[],
): void {
  const entry = KNOWN_BROKEN_AGENTS[slug];
  if (!entry) {
    expect(messages, JSON.stringify(messages, null, 2)).toEqual([]);
    return;
  }
  const actualCodes = [
    ...new Set(
      messages.map((m) => m.match(ERROR_CODE_PREFIX_RE)?.[0] ?? "<no-code>"),
    ),
  ].sort();
  const expectedCodes = [...entry.expectedCodes].sort();
  expect(
    actualCodes,
    `Allowlist code drift for ${slug}: expected ${JSON.stringify(expectedCodes)}, got ${JSON.stringify(actualCodes)}. Messages: ${JSON.stringify(messages, null, 2)}`,
  ).toEqual(expectedCodes);
  expect(
    messages,
    `Allowlist count drift for ${slug}: expected ${entry.expectedBlockerCount}, got ${messages.length}. Messages: ${JSON.stringify(messages, null, 2)}`,
  ).toHaveLength(entry.expectedBlockerCount);
  // Identity pin: every expected location/identity substring must appear in
  // at least one allowed message. Prevents same-code/same-count masking of
  // an unrelated finding elsewhere in the OAS.
  const blob = messages.join("\n");
  for (const loc of entry.expectedLocations) {
    expect(
      blob.includes(loc),
      `Allowlist location pin missed for ${slug}: expected substring ${JSON.stringify(loc)} in some message. Messages: ${JSON.stringify(messages, null, 2)}`,
    ).toBe(true);
  }
}
