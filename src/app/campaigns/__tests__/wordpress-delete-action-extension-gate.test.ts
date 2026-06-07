/**
 * Security regression: the WordPress connector's delete action MUST gate on
 * `requireExtensionAction(WORDPRESS_PACKAGE_ID, "manage")` as the FIRST
 * executable statement.
 *
 * `deleteWordPressInstanceAction` lives in the connector. The single canonical
 * gate is `requireExtensionAction(WORDPRESS_PACKAGE_ID, "manage")` (org-admin
 * via the uniform connector access model — the same authority
 * `enforceConnectorPolicy(..., "manage")` enforces), shared by BOTH the legacy
 * `/connectors/wordpress` page and the dispatch-route settings page.
 *
 * Lives under src/ (root-vitest-covered AND explicitly CI-pinned in
 * build-image.yml) — NOT co-located in the extension — so the invariant is
 * enforced in CI (root vitest `include` skips extensions/**).
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function extractFunctionBody(source: string, fnName: string): string {
  const marker = new RegExp(`(?:export\\s+)?async function ${fnName}\\b`);
  const m = marker.exec(source);
  if (!m) throw new Error(`fn ${fnName} not found`);
  let i = source.indexOf("{", m.index);
  const bodyStart = i;
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  return source.slice(bodyStart + 1, i);
}

function firstExecutableStatement(body: string): string {
  let s = body;
  for (;;) {
    const before = s;
    s = s.replace(/^\s+/, "");
    if (s.startsWith("//")) {
      const nl = s.indexOf("\n");
      s = nl === -1 ? "" : s.slice(nl + 1);
    } else if (s.startsWith("/*")) {
      const end = s.indexOf("*/");
      s = end === -1 ? "" : s.slice(end + 2);
    } else if (/^["']use server["'];/.test(s)) {
      s = s.replace(/^["']use server["'];/, "");
    }
    if (s === before) break;
  }
  return s;
}

describe("wordpress relocated delete action — extension manage gate", () => {
  it("deleteWordPressInstanceAction: the FIRST executable statement is the requireExtensionAction manage gate", () => {
    const source = readFileSync(
      join(process.cwd(), "extensions/cinatra-ai/wordpress-mcp-connector/src/setup-actions.ts"),
      "utf-8",
    );
    const body = extractFunctionBody(source, "deleteWordPressInstanceAction");
    expect(
      firstExecutableStatement(body).startsWith(
        `await requireExtensionAction(WORDPRESS_PACKAGE_ID, "manage");`,
      ),
    ).toBe(true);
  });

  // Reach-around guard: an UNGATED WordPress-delete export in the
  // @cinatra-ai/connectors "use server" hub module, or a forwarder in
  // src/app/campaigns/actions.ts, would be a lower-privilege path around the
  // manage-gated connector action — assert neither re-exposes one.
  it("the legacy WordPress-delete reach-arounds (hub + campaigns forwarder) do NOT exist", () => {
    // The @cinatra-ai/connectors hub actions module does not exist (every action
    // lives in its own connector); a missing file trivially cannot contain the
    // reach-around.
    const hubPath = join(process.cwd(), "packages/connectors/src/actions.ts");
    const hub = existsSync(hubPath) ? readFileSync(hubPath, "utf-8") : "";
    const campaigns = readFileSync(
      join(process.cwd(), "src/app/campaigns/actions.ts"),
      "utf-8",
    );
    expect(hub.includes("export async function deleteWordPressInstanceAction")).toBe(false);
    expect(campaigns.includes("export async function deleteWordPressInstanceAction")).toBe(false);
  });
});
