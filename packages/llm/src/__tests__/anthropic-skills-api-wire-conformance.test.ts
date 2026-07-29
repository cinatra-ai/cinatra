/**
 * Anthropic Skills API WIRE conformance (cinatra#2094, epic #2086 S7).
 *
 * The S0 seed (`anthropic-custom-skills-client-conformance.test.ts`) asserts the
 * request shapes our client SENDS. This file asserts our client against the
 * response shapes the API actually RETURNS — captured from a real round trip
 * during the S7 live acceptance run (`evidence/2094-s7-acceptance/live-results.json`,
 * 68 live requests against `api.anthropic.com` with the org key).
 *
 * The captured list contract, verbatim from the wire:
 *
 *     { "data": [...], "has_more": true, "next_page": "<opaque cursor>" }
 *
 * There is **no `last_id`**, and the forward cursor is the `page` query
 * parameter — not `after_id`. Both list clients in
 * `anthropic-custom-skills-client.ts` advance on `has_more` + `last_id` ->
 * `after_id`, so against the real API their loops always terminate after the
 * first page. Two of the tests below therefore encode the CORRECT contract and
 * are marked `.fails` — they document a live-verified defect (finding **F1** on
 * cinatra#2094) without turning CI red, and vitest reports an unexpected PASS
 * the moment the client is fixed, which is the signal to drop the marker.
 *
 * Deliberately NOT here: companion tests asserting the current defective
 * behavior. They would be redundant with the `.fails` pair and would normalize
 * the bug into the suite's expectations.
 *
 * Everything here is deterministic: `fetch` is stubbed with the captured shape,
 * no key is required, and no live call is made. The live arm lives in
 * `evidence/2094-s7-acceptance/drivers/live-skills-api-probe.mjs`.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  FetchAnthropicCustomSkillsClient,
  FetchAnthropicCustomSkillsGcClient,
  ANTHROPIC_SKILLS_BETAS,
  type AnthropicSkillUpload,
} from "../tools/anthropic-custom-skills-client";

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const UPLOAD: AnthropicSkillUpload = {
  displayTitle: "cinatra 2094 wire fixture",
  rootDir: "wire-fixture",
  zipBytes: Buffer.from("PKzip"),
};

/**
 * The EXACT list envelope the live API returned (keys sorted): `data`,
 * `has_more`, `next_page`. Captured 2026-07-29 against the `skills-2025-10-02`
 * beta. Pinning it here means a future envelope change is caught by CI rather
 * than by a silently truncated GC walk.
 */
const CAPTURED_LIST_ENVELOPE_KEYS = ["data", "has_more", "next_page"] as const;

describe("captured live wire envelope", () => {
  it("the list envelope carries next_page and NOT last_id", () => {
    // This is the observation the two `.fails` tests below are derived from.
    expect([...CAPTURED_LIST_ENVELOPE_KEYS].sort()).toEqual(["data", "has_more", "next_page"]);
    expect(CAPTURED_LIST_ENVELOPE_KEYS).not.toContain("last_id");
  });

  it("the stacked betas the live API accepted are the ones the client sends", () => {
    // The live run authenticated and succeeded with exactly this beta string.
    expect(ANTHROPIC_SKILLS_BETAS).toBe(
      "code-execution-2025-08-25,skills-2025-10-02,files-api-2025-04-14",
    );
  });
});

/** Two-page versions history in the REAL envelope shape. */
function stubTwoPageVersionsWire(): { urls: string[] } {
  const urls: string[] = [];
  global.fetch = vi.fn(async (url: string | URL) => {
    const u = String(url);
    urls.push(u);
    const parsed = new URL(u);
    const page = parsed.searchParams.get("page");
    if (page === "cursor-page-2") {
      return jsonResponse({ data: [{ version: "v3" }], has_more: false, next_page: null });
    }
    return jsonResponse({
      data: [{ version: "v1" }, { version: "v2" }],
      has_more: true,
      next_page: "cursor-page-2",
    });
  }) as unknown as typeof fetch;
  return { urls };
}

describe("GC listSkillVersions against the real list envelope", () => {
  // DEFECT (live-verified, reported on cinatra#2094): the walk keys on
  // `last_id`, which the API never returns, so it stops after page 1. The
  // documented S0 deliverable — "paginate listSkillVersions to exhaustion
  // before any deleteSkill" — is therefore not achieved against the real API.
  //
  // Blast radius: the client requests `limit=100`, so a history of <=100
  // versions fits one page and today's GC is correct. Past 100 versions the
  // walk returns only the first 100; the subsequent skill delete is then
  // REFUSED by the API (the live run confirmed the server enforces
  // versions-before-skill ordering), wedging the GC run — exactly the failure
  // S0 set out to remove.
  it.fails("paginates to exhaustion via next_page and returns EVERY version", async () => {
    stubTwoPageVersionsWire();
    const gc = new FetchAnthropicCustomSkillsGcClient("sk-test");
    const versions = await gc.listSkillVersions("skill_1");
    // Narrow on purpose: this asserts ONLY the pagination contract, so the test
    // can fail for no reason other than the F1 defect. When F1 is fixed this
    // starts passing, vitest reports the unexpected pass, and the `.fails`
    // marker must be dropped.
    expect(versions).toEqual(["v1", "v2", "v3"]);
  });
});

describe("display_title collision reconciliation against the real list envelope", () => {
  /**
   * A create that collides on `display_title` must reconcile to the existing
   * remote skill rather than duplicating. The live run confirmed the API DOES
   * reject a duplicate title (HTTP 4xx, body matched by the shipped
   * `isDisplayTitleConflict` predicate), so this reconciliation path is load
   * bearing — it is what keeps a lost create response from stranding a skill.
   */
  function stubCollisionThenTwoPageList(): void {
    global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "POST" && u.endsWith("/v1/skills")) {
        return new Response('{"error":{"message":"display_title must be unique"}}', { status: 400 });
      }
      const parsed = new URL(u);
      const page = parsed.searchParams.get("page");
      if (page === "cursor-page-2") {
        return jsonResponse({
          data: [{ id: "skill_mine", display_title: UPLOAD.displayTitle, latest_version: "v7" }],
          has_more: false,
          next_page: null,
        });
      }
      // Page 1 does NOT contain the colliding title.
      return jsonResponse({
        data: [{ id: "skill_other", display_title: "someone else", latest_version: "v1" }],
        has_more: true,
        next_page: "cursor-page-2",
      });
    }) as unknown as typeof fetch;
  }

  // Same root cause as above: the reconciliation walk cannot reach page 2.
  // Blast radius: `limit=100`, so a workspace with <=100 custom skills
  // reconciles correctly; past 100 the create rethrows instead of adopting the
  // existing remote identity.
  it.fails("finds the colliding title on a later page via next_page", async () => {
    stubCollisionThenTwoPageList();
    const client = new FetchAnthropicCustomSkillsClient("sk-test");
    // Narrow on purpose — see the note on the sibling `.fails` test above.
    await expect(client.createSkill(UPLOAD)).resolves.toEqual({
      skillId: "skill_mine",
      version: "v7",
    });
  });
});

describe("delete ordering is server-enforced (live-verified)", () => {
  /**
   * The live run attempted `DELETE /v1/skills/{id}` while versions were still
   * present and the API REFUSED it. That makes the GC engine's
   * versions-then-skill ordering a hard requirement, not a courtesy — so the
   * client must keep issuing version deletes before the skill delete.
   */
  it("issues every version delete before the skill delete", async () => {
    const hits: string[] = [];
    global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      hits.push(`${init?.method} ${new URL(String(url)).pathname}`);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const gc = new FetchAnthropicCustomSkillsGcClient("sk-test");
    await gc.deleteSkillVersion("skill_1", "v1");
    await gc.deleteSkillVersion("skill_1", "v2");
    await gc.deleteSkill("skill_1");

    expect(hits).toEqual([
      "DELETE /v1/skills/skill_1/versions/v1",
      "DELETE /v1/skills/skill_1/versions/v2",
      "DELETE /v1/skills/skill_1",
    ]);
    // The skill delete is last — the ordering the API enforces.
    expect(hits[hits.length - 1]).toBe("DELETE /v1/skills/skill_1");
  });
});
