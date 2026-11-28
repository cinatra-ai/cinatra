// ---------------------------------------------------------------------------
// POST /api/cli/extensions/install — authenticated agent or skill package
// install for `cinatra agents install` (cinatra#4920).
//
// Body: `{ packageName: "@scope/name", version: "<exact version>" }`.
//
// A THIN CALLER of the canonical install primitive: the function behind the
// `extensions_install` MCP tool. That primitive authorizes the root once on the
// gatekept path, resolves the package through the lifecycle resolution,
// applies the private-package visibility gate, and hands the install to the
// dependency batch (each member dispatched to its kind handler; an agent
// compiles from `cinatra/oas.json`, writes its rows and materializes; one
// agent-runtime reload at the batch success boundary). The route adds no
// install logic of its own.
//
// KINDS: only `agent` and `skill`. Connector, artifact and workflow roots need
// an explicit access target (install-access-target.ts), which only the
// product's marketplace page collects; the primitive refuses them through
// `allowedKinds` right after its own resolution, before any install work.
//
// VERSION: required and exact, checked with the repository's canonical
// validator (`isExactVersion`). The primitive needs a version, and its
// non-gatekept resolution reads the given string as a literal version, so a
// range, a dist-tag or "latest" is refused here with 400.
//
// HANDLERS: the side-effect import of `handler-bootstrap` registers the kind
// handlers in this worker; without it a route worker that never loaded the MCP
// boot module has an empty handler registry and every install fails.
//
// AUTH: PLATFORM-ADMIN ONLY via `authorizeCliRequest` — the exact mirror of
// `/api/cli/extensions/reconcile/apply`: cookie session, a verified remote
// Bearer carrying `cli:extensions:write`, or the dev-admin loopback bypass.
//
// CSRF: `authorizeCliRequest` accepts a cookie session FIRST, so a cross-site
// page could otherwise trigger an install with the admin's cookie (a
// CORS-simple `text/plain` POST needs no preflight). Before any authorization
// work the route therefore (1) refuses a cross-origin request through the
// repository's cookie-backed admin mutation guard (`rejectCrossOrigin`) and
// (2) requires `Content-Type: application/json`, which a cross-site page can
// only send after a CORS preflight this instance never grants. The CLI sends
// no `Origin` header and sends JSON.
//
// ACTOR: the standing-free install envelope, the shape the UI install wrapper
// hands the batch (`buildActorEnvelope`). No `platformRole`: the batch's
// compensation uninstalls with this actor, and platform standing there would
// take the package-global teardown branch for a dependency other orgs use.
//
// ERRORS: known refusals return their own safe message with a 4xx; anything
// else returns a fixed message with 500 and is logged server-side only.
// ---------------------------------------------------------------------------

import "@cinatra-ai/extensions/handler-bootstrap";

import { NextResponse } from "next/server";

import type { Actor } from "@cinatra-ai/extension-types";
import {
  createExtensionsPrimitiveHandlers,
  EXTENSION_KIND_NOT_ALLOWED,
  EXTENSION_NOT_VISIBLE,
} from "@cinatra-ai/extensions/mcp-handlers";
import { classifyMarketplaceFailure } from "@cinatra-ai/extensions/screens/marketplace-failure-copy";
import { isExactVersion } from "@cinatra-ai/registries/src/version-compare";
import { rejectCrossOrigin } from "@/lib/admin-origin-guard";
import { authorizeCliRequest } from "@/lib/cli-api/route-guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The root kinds this route installs (no access target needed). */
const ALLOWED_KINDS = ["agent", "skill"] as const;

// The scoped package name the install surfaces accept (the
// `extensions_install` MCP schema's pattern).
const PACKAGE_NAME_RE = /^@[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;
// The body is two short strings; a larger body is refused before parsing.
const MAX_BODY_BYTES = 16 * 1024;
// Known refusal codes, looked up along the error's `cause` chain: the install
// batch wraps a member failure in `BatchMemberInstallError` and keeps the
// registry error as its `cause`.
const KNOWN_CODES = new Set<string>([
  EXTENSION_KIND_NOT_ALLOWED,
  EXTENSION_NOT_VISIBLE,
  "E404",
  "ETARGET",
]);
const MAX_CAUSE_DEPTH = 6;

const GENERIC_FAILURE = "Failed to install the extension package.";

function json(body: Record<string, unknown>, status: number): Response {
  return NextResponse.json(body, { status });
}

/** The first known refusal code on the error or its `cause` chain, and the error that carries it. */
function findKnownCode(error: unknown): { code: string; carrier: unknown } | null {
  let node: unknown = error;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && node != null && typeof node === "object"; depth++) {
    const code = (node as { code?: unknown }).code;
    if (typeof code === "string" && KNOWN_CODES.has(code)) return { code, carrier: node };
    node = (node as { cause?: unknown }).cause;
  }
  return null;
}

export async function POST(request: Request): Promise<Response> {
  const crossOrigin = rejectCrossOrigin(request);
  if (crossOrigin) return crossOrigin;
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(contentType)) {
    return json({ error: "Content-Type must be application/json." }, 415);
  }

  const guard = await authorizeCliRequest(request, {
    minTier: "platform-admin",
    requiredScope: "cli:extensions:write",
  });
  if (!guard.ok) {
    return json({ error: guard.error }, guard.status);
  }

  const declaredLength = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return json({ error: "Request body too large." }, 413);
  }
  let parsed: unknown;
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
      return json({ error: "Request body too large." }, 413);
    }
    parsed = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return json({ error: "Request body must be a JSON object." }, 400);
  }
  const { packageName, version } = parsed as { packageName?: unknown; version?: unknown };
  if (typeof packageName !== "string" || !PACKAGE_NAME_RE.test(packageName)) {
    return json(
      {
        error:
          "`packageName` must be a scoped package name (@scope/name, lowercase letters, digits and hyphens).",
      },
      400,
    );
  }
  // The canonical validator tolerates a leading "v" and surrounding spaces; the
  // string is passed on as written, so those forms are refused here too.
  if (typeof version !== "string" || !/^\d/.test(version) || /\s$/.test(version) || !isExactVersion(version)) {
    return json(
      { error: "`version` is required and must be an exact version (for example 1.2.3), not a range or a tag." },
      400,
    );
  }

  const actor: Actor = {
    actorType: "human",
    source: "route",
    ...(guard.actor.userId ? { userId: guard.actor.userId } : {}),
    ...(guard.actor.organizationId ? { orgId: guard.actor.organizationId } : {}),
  };
  const target = `${packageName}@${version}`;

  try {
    const result = await createExtensionsPrimitiveHandlers().extensions_install(
      { packageName, packageVersion: version },
      actor,
      { allowedKinds: ALLOWED_KINDS },
    );
    if (result.success) {
      return NextResponse.json(
        { packageName: result.packageName, version: result.packageVersion },
        { status: 200, headers: { "Cache-Control": "no-store" } },
      );
    }
    if ("contractViolation" in result) {
      return json({ error: result.message, missingFields: result.missingFields }, 422);
    }
    return json({ error: result.message }, 409);
  } catch (error) {
    const known = findKnownCode(error);
    const code = known?.code;
    if (code === EXTENSION_KIND_NOT_ALLOWED) {
      const kind = (known!.carrier as { kind?: unknown }).kind;
      return json(
        {
          error: `${packageName} is ${typeof kind === "string" ? `a ${kind}` : "an extension"} package. Only agent and skill packages install over this route; install it from the product's marketplace page, which collects its access target.`,
        },
        422,
      );
    }
    if (code === EXTENSION_NOT_VISIBLE) {
      return json({ error: `Package ${packageName} is private and not accessible from this instance.` }, 403);
    }
    if (code === "E404" || code === "ETARGET") {
      return json({ error: `Not found in the registry: ${target} or one of its dependencies.` }, 404);
    }
    const category = classifyMarketplaceFailure(error);
    if (category === "denied-entitlement") {
      return json({ error: `This instance is not entitled to install ${target}.` }, 403);
    }
    if (category === "unavailable-version") {
      return json({ error: `${target} is not available from the marketplace.` }, 404);
    }
    if (category === "retryable") {
      return json({ error: "The marketplace is temporarily unavailable. Retry later." }, 503);
    }
    console.error("[cli-api/extensions/install] failed", error);
    return json({ error: GENERIC_FAILURE }, 500);
  }
}
