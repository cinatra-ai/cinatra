"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { APIError } from "better-auth/api";
import { auth } from "@/lib/auth";
import { requireAuthSession } from "@/lib/auth-session";
import { userCanCreateOrganizations } from "@/lib/authz/organization-create-gate";
import { toOrganizationSlugBase } from "./organization-slug";

/** Max slug-allocation attempts before giving up (matches the team slug
 *  allocation budget). Org slugs are globally unique and each attempt is a
 *  full create call the endpoint rejects atomically on collision, so a retry
 *  never leaves a partial organization behind. */
const MAX_SLUG_ATTEMPTS = 100;

/** Read the Better Auth error code off a thrown endpoint error (the
 *  endpoint throws `APIError` with `body.code` set to the SCREAMING_SNAKE
 *  key, e.g. "ORGANIZATION_ALREADY_EXISTS"). */
function betterAuthErrorCode(error: unknown): string | undefined {
  if (!(error instanceof APIError)) return undefined;
  const code = (error.body as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? code : undefined;
}

export async function createOrganizationAction(formData: FormData) {
  const session = await requireAuthSession();
  const name = String(formData.get("name") ?? "").trim();

  if (!name) {
    redirect("/organizations/new?error=missing-name");
  }

  // App-level gate — the same predicate that shows/hides the page action and
  // the /organizations/new page, so a direct POST cannot reach further than
  // the UI allows. Better Auth's `allowUserToCreateOrganization`
  // (src/lib/auth.ts) stays the authoritative enforcement inside the create
  // endpoint below and re-runs regardless.
  if (!(await userCanCreateOrganizations(session))) {
    redirect("/not-authorized");
  }

  const slugBase = toOrganizationSlugBase(name);

  // Create through the SAME Better Auth endpoint the global `+` menu's
  // CreateOrganizationDialog calls — creation logic (membership row, plugin
  // hooks, active-org semantics) is not forked here. Two deliberate choices:
  //   - Slug allocation: org slugs are globally unique, so allocate via
  //     create-and-retry with an incrementing `-<n>` suffix (the API-seam
  //     analogue of createTeamAction's ON CONFLICT loop; the endpoint rejects
  //     a taken slug with ORGANIZATION_ALREADY_EXISTS before creating
  //     anything).
  //   - Active org: the body intentionally omits
  //     `keepCurrentActiveOrganization`, so the endpoint itself switches the
  //     session's active organization to the new org — landing on an
  //     active-org-scoped surface afterwards reflects the just-created org
  //     (the created-but-not-active trap #1495 guards against; teams needed
  //     an explicit post-create switch only because team rows are written
  //     outside this endpoint).
  // Redirects stay OUTSIDE the try/catch: Next's redirect() throws to unwind
  // and must not be swallowed as a create failure.
  let outcome: "created" | "forbidden" | "slug-exhausted" = "slug-exhausted";
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 0 ? slugBase : `${slugBase}-${attempt + 1}`;
    try {
      await auth.api.createOrganization({
        headers: await headers(),
        body: { name, slug: candidate },
      });
      outcome = "created";
      break;
    } catch (error) {
      const code = betterAuthErrorCode(error);
      if (code === "ORGANIZATION_ALREADY_EXISTS") {
        // Slug taken — try the next suffix.
        continue;
      }
      if (code === "YOU_ARE_NOT_ALLOWED_TO_CREATE_A_NEW_ORGANIZATION") {
        outcome = "forbidden";
        break;
      }
      // Unexpected failure: surface it rather than redirecting somewhere
      // that would imply success or bury the cause.
      throw error;
    }
  }

  if (outcome === "forbidden") {
    redirect("/not-authorized");
  }
  if (outcome === "slug-exhausted") {
    redirect("/organizations/new?error=slug-unavailable");
  }

  redirect("/organizations");
}
