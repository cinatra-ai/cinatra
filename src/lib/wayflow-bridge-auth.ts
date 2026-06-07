import "server-only";
import { timingSafeEqual } from "node:crypto";

// ---------------------------------------------------------------------------
// WayFlow Bridge Auth (strict token only)
//
// Shared shared-secret helper used by:
//   - /api/llm-bridge (dual-auth: this OR Bearer JWT)
//   - /api/a2a/agents/[slug]/route.ts (this is the SOLE gate for the
//     agent-card discovery GET; POST is dual-auth)
//
// Auth contract:
//   - When CINATRA_BRIDGE_TOKEN is set, the request MUST carry a matching
//     X-Cinatra-Bridge-Token header. Length-mismatch short-circuits before
//     timingSafeEqual (the constant-time API requires equal-length buffers).
//   - When CINATRA_BRIDGE_TOKEN is unset, ALL requests are denied.
//
// The "internal bypass" env-var escape hatch and X-Forwarded-For loopback
// fallback are not allowed. They are spoofable in production because XFF is
// not authoritative when the app is reachable directly, and the bypass env var
// is a foot-gun for production deployments. The WayFlow and content-editor
// containers all pass ${CINATRA_BRIDGE_TOKEN} via docker-compose.yml.
// Production MUST set CINATRA_BRIDGE_TOKEN - see .env.example.
// ---------------------------------------------------------------------------

export function isAuthorizedBridgeRequest(req: Request): boolean {
  const expectedToken = process.env.CINATRA_BRIDGE_TOKEN;
  if (!expectedToken) {
    return false;
  }
  const providedHeader = req.headers.get("x-cinatra-bridge-token") ?? "";
  const providedBuf = Buffer.from(providedHeader);
  const expectedBuf = Buffer.from(expectedToken);
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}
