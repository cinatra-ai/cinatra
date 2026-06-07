import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  mergeReviewLanes,
  restampLaneSource,
  type ReviewFinding,
  type ReviewLaneSource,
} from "@cinatra-ai/agents";
import { isAuthorizedBridgeRequest } from "@/lib/wayflow-bridge-auth";

/**
 * `/api/review/merge` is the merge step for the
 * `@cinatra/agent-creation-finalizer` Flow's `merge_review` ApiNode. Takes
 * four JSON-stringified `ReviewFinding[]` inputs (one per review helper),
 * parses + re-stamps source identity per lane (so helper-reported source
 * can't be spoofed), and aggregates via the shared `mergeReviewLanes`
 * helper.
 *
 * Chat-authoring code paths SHOULD call the `agent_creation_review` MCP
 * primitive (`@cinatra-ai/agents`/agent-creation-review.ts) instead, which
 * runs the same lanes in-process and aggregates without the HTTP round-trip.
 * This route is kept for:
 *   1. Tarball-aged Flow ApiNodes still referencing it.
 *   2. Any future external orchestrator that wants the trust boundary
 *      without writing TypeScript.
 *
 * Auth: bridge-token only, matching every internal endpoint dispatched
 * from the WayFlow runtime.
 *
 * Body shape:
 *   {
 *     lintFindings:      string,  // JSON of ReviewFinding[]
 *     securityFindings:  string,  // JSON of ReviewFinding[]
 *     codeFindings:      string,  // JSON of ReviewFinding[]
 *     plannerFindings:   string,  // JSON of ReviewFinding[]
 *     agent_id?:         string,  // ignored
 *     agent_run_id?:     string,  // ignored
 *   }
 *
 * Response shape:
 *   {
 *     ok: true,
 *     merged: string,  // JSON.stringify({ blockers, warnings, suggestions, findings })
 *   }
 *
 * Why JSON-string in `merged`? The OAS ApiNode declared `outputs: [{ title:
 * "merged", type: "string" }]`. The downstream EndNode propagated the
 * string verbatim. Chat-runner / publish-gate consumers parse the string
 * to access the buckets.
 */

const BodySchema = z
  .object({
    lintFindings: z.string().optional(),
    securityFindings: z.string().optional(),
    codeFindings: z.string().optional(),
    plannerFindings: z.string().optional(),
  })
  .passthrough();

/**
 * Parse a JSON-stringified `ReviewFinding[]` defensively + re-stamp lane
 * source. The response shape is preserved (`findings` array out,
 * soft-error single-warning fallback), and stamping is centralized in the
 * shared `restampLaneSource` helper so the MCP primitive and HTTP route stay
 * identical on this concern.
 *
 * SECURITY: re-stamps every finding's `source` to the lane-authoritative
 * value before returning. A helper agent cannot spoof its source — the
 * merge endpoint owns the source identity per-lane. This prevents a
 * security-reviewer lane from emitting `{ severity: "blocker", source:
 * "agent-lint-policy" }` and surviving the `normalizeReviewFindings`
 * downgrade check (which trusts `source` to decide blocker authority).
 */
function parseFindings(
  raw: string | undefined,
  laneSource: ReviewLaneSource,
): ReviewFinding[] {
  if (!raw || raw.trim() === "") return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [
        {
          code: "review_parse_error",
          severity: "warning",
          message: `Helper "${laneSource}" returned a non-array findings payload; treating as empty.`,
          source: laneSource,
        },
      ];
    }
    // Build findings WITHOUT stamping `source` here — the canonical stamp
    // happens once via `restampLaneSource` so source-policy changes have a
    // single point of truth.
    const findings: ReviewFinding[] = (parsed as Array<Record<string, unknown>>).map((f) => ({
      code: typeof f.code === "string" ? f.code : "unknown",
      severity:
        f.severity === "blocker" || f.severity === "warning" || f.severity === "suggestion"
          ? (f.severity as "blocker" | "warning" | "suggestion")
          : ("suggestion" as const),
      message: typeof f.message === "string" ? f.message : "",
      ...(typeof f.location === "string" ? { location: f.location } : {}),
      // Placeholder source — `restampLaneSource` overwrites below.
      source: laneSource,
    }));
    return restampLaneSource(findings, laneSource);
  } catch {
    return [
      {
        code: "review_parse_error",
        severity: "warning",
        message: `Helper "${laneSource}" returned unparseable findings JSON; treating as empty.`,
        source: laneSource,
      },
    ];
  }
}

export async function POST(req: Request): Promise<Response> {
  if (!isAuthorizedBridgeRequest(req)) {
    return NextResponse.json(
      { ok: false, error: "unauthorized: bridge token required" },
      { status: 401 },
    );
  }

  let body: z.infer<typeof BodySchema>;
  try {
    const raw = (await req.json()) as unknown;
    const parsed = BodySchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json(
        {
          ok: false,
          error: `invalid request body: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
        },
        { status: 400 },
      );
    }
    body = parsed.data;
  } catch (err) {
    const message = err instanceof Error ? err.message : "malformed JSON body";
    return NextResponse.json({ ok: false, error: message }, { status: 400 });
  }

  const lintFindings = parseFindings(body.lintFindings, "agent-lint-policy");
  const securityFindings = parseFindings(body.securityFindings, "agent-security-reviewer");
  const codeFindings = parseFindings(body.codeFindings, "agent-code-reviewer");
  const plannerFindings = parseFindings(body.plannerFindings, "agent-planner");

  const merged = mergeReviewLanes({
    lintFindings,
    securityFindings,
    codeFindings,
    plannerFindings,
  });

  return NextResponse.json({
    ok: true,
    merged: JSON.stringify({
      blockers: merged.blockers,
      warnings: merged.warnings,
      suggestions: merged.suggestions,
      findings: merged.findings,
    }),
  });
}
