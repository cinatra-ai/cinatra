import "server-only";

import { NextResponse } from "next/server";
import { z } from "zod";
import {
  scanOasForLiteralSecrets,
  scanOasForUntrustedUrls,
  scanOasForLlmBridgeWiring,
  scanOasForLlmMetadata,
  scanOasForStartNodeInputsWithoutRequired,
  scanOasForPackageVersionSync,
  scanAgentForRequiredLicense,
  type ReviewFinding,
} from "@cinatra-ai/agents";
import { isAuthorizedBridgeRequest } from "@/lib/wayflow-bridge-auth";

/**
 * `/api/oas-lint/scan-all` — internal lint endpoint dispatched by
 * `@cinatra-ai/lint-policy-agent` (the deterministic policy agent). Returns
 * a normalized `ReviewFinding[]` with `source: "agent-lint-policy"`.
 *
 * Auth: bridge-token only, matching `/api/llm-bridge` and the rest of
 * the WayFlow-runtime-to-Cinatra internal call surface.
 *
 * Body shape:
 *   {
 *     oasJson: string | object,         // OAS Flow body to lint
 *     packageJson?: string | object,    // optional sibling package.json
 *     packageSlug?: string,             // optional slug for context
 *     policyVersion?: "v1",             // future-pinning hook; currently always "v1"
 *     agent_id?: string,                // (passed through by the OAS, ignored here)
 *     agent_run_id?: string             // (passed through by the OAS, ignored here)
 *   }
 *
 * Response shape:
 *   {
 *     ok: true,
 *     source: "agent-lint-policy",
 *     rulesRun: string[],
 *     findings: ReviewFinding[]
 *   }
 *
 * Why is this an HTTP endpoint and not an inline call? Because the
 * `@cinatra-ai/lint-policy-agent` agent is the canonical lint surface — every
 * dispatch path (chat advisory review, publish hard-gate, compile hard-gate)
 * goes through that agent via A2A, and the agent's OAS body wraps this
 * endpoint as its single ApiNode. The endpoint exists to expose the TS
 * scanners through the agent's flow graph.
 */

const BodySchema = z.object({
  oasJson: z.union([z.string(), z.record(z.string(), z.unknown())]),
  packageJson: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
  packageSlug: z.string().optional(),
  policyVersion: z.string().optional(),
}).passthrough();

const RULES_RUN = [
  "literal_secrets_in_oas",
  "untrusted_external_url",
  "agent_id_missing_on_llm_bridge",
  "llm_metadata_drift",
  "start_node_inputs_without_required",
  "package_version_drift",
  "required_license_missing",
] as const;

function asObject(value: string | Record<string, unknown> | undefined): Record<string, unknown> | null {
  if (value === undefined) return null;
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Normalize every finding's `source` to "agent-lint-policy" so callers
 * have a single authoritative source for blockers. The inline scanners
 * stamp `source: "deterministic"` historically; the endpoint rewrites
 * them at the boundary so downstream consumers can rely on the agent
 * identity, not the implementation detail of which TS function emitted
 * the finding.
 */
function stampSource(findings: ReviewFinding[]): ReviewFinding[] {
  return findings.map((f) => ({ ...f, source: "agent-lint-policy" as const }));
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

  const oas = asObject(body.oasJson);
  if (oas === null) {
    return NextResponse.json(
      { ok: false, error: "oasJson must be a JSON object (or a JSON-stringified object)" },
      { status: 400 },
    );
  }

  const packageJson = asObject(body.packageJson);

  // Collect findings from every scanner. Each scanner is pure
  // (Record<string, unknown> → ReviewFinding[]); we sequence them
  // synchronously in-process. The endpoint is the authoritative
  // serialization boundary for the policy agent.
  const findings: ReviewFinding[] = [
    ...scanOasForLiteralSecrets(oas),
    ...scanOasForUntrustedUrls(oas),
    ...scanOasForLlmBridgeWiring(oas),
    ...scanOasForLlmMetadata(oas),
    ...scanOasForStartNodeInputsWithoutRequired(oas),
  ];

  if (packageJson) {
    findings.push(...scanOasForPackageVersionSync(oas, packageJson));
    findings.push(...scanAgentForRequiredLicense(packageJson));
  }

  const stamped = stampSource(findings);

  // The agent's ApiNode declares `findings: string` to match the
  // single-string convention every Cinatra review helper uses (see
  // `@cinatra-ai/code-reviewer-agent`'s OAS). The downstream
  // OutputMessageNode renders this string into the agent's conversation
  // history, which is what A2A callers consume. Returning a raw array
  // here would type-mismatch against the ApiNode's declared output type.
  return NextResponse.json({
    ok: true,
    source: "agent-lint-policy" as const,
    rulesRun: RULES_RUN,
    findings: JSON.stringify(stamped),
  });
}
