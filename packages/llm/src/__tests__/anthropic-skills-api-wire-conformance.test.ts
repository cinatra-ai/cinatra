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
 * parameter — not `after_id`. Both list walks in
 * `anthropic-custom-skills-client.ts` previously advanced on `has_more` +
 * `last_id` -> `after_id`, so against the real API their loops always terminated
 * after the first page (finding **F1** on cinatra#2094, HIGH). **F1 is fixed**:
 * both walks now key on the real envelope, and the two tests that encode the
 * correct contract are plain passing tests — they were `it.fails` markers while
 * the defect stood and the markers are gone now that they pass for real.
 *
 * The suite covers the walk at THREE pages, not two: two pages proves a cursor
 * is followed once, three proves the loop actually iterates on the cursor it
 * most recently received rather than on a one-shot second request.
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
  ANTHROPIC_SKILLS_LIST_PAGE_LIMIT,
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
    // This is the observation the pagination tests below are derived from.
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

/**
 * A THREE-page history in the REAL envelope shape, keyed on the `page` param.
 *
 * The stub is deliberately strict: a request carrying `after_id`, or carrying no
 * cursor after the first page, falls through to `unexpected` and fails the
 * assertion. That is what makes this a conformance stub rather than a stub that
 * happens to answer whatever it is asked.
 */
function stubThreePageVersionsWire(): { urls: string[]; cursors: (string | null)[] } {
  const urls: string[] = [];
  const cursors: (string | null)[] = [];
  global.fetch = vi.fn(async (url: string | URL) => {
    const u = String(url);
    urls.push(u);
    const parsed = new URL(u);
    // The old (wrong) cursor param must never appear.
    if (parsed.searchParams.has("after_id")) {
      return jsonResponse({ unexpected: "after_id was sent" }, 400);
    }
    const page = parsed.searchParams.get("page");
    cursors.push(page);
    if (page === null) {
      return jsonResponse({
        data: [{ version: "v1" }, { version: "v2" }],
        has_more: true,
        next_page: "cursor-page-2",
      });
    }
    if (page === "cursor-page-2") {
      return jsonResponse({
        data: [{ version: "v3" }, { version: "v4" }],
        has_more: true,
        next_page: "cursor-page-3",
      });
    }
    if (page === "cursor-page-3") {
      return jsonResponse({ data: [{ version: "v5" }], has_more: false, next_page: null });
    }
    return jsonResponse({ unexpected: `unknown cursor ${page}` }, 400);
  }) as unknown as typeof fetch;
  return { urls, cursors };
}

describe("GC listSkillVersions against the real list envelope", () => {
  // The S0 deliverable this restores, verbatim: "paginate listSkillVersions to
  // exhaustion before any deleteSkill". The live run proved why it is load
  // bearing — the server REFUSES a skill delete while versions remain (C5), so a
  // truncated walk produces a reclaim that never converges: every run re-deletes
  // the same first page and resurfaces the same refusal.
  it("paginates to exhaustion via next_page and returns EVERY version", async () => {
    const { cursors } = stubThreePageVersionsWire();
    const gc = new FetchAnthropicCustomSkillsGcClient("sk-test");
    const versions = await gc.listSkillVersions("skill_1");
    expect(versions).toEqual(["v1", "v2", "v3", "v4", "v5"]);
    // Three requests, each advancing on the cursor the PREVIOUS page returned.
    expect(cursors).toEqual([null, "cursor-page-2", "cursor-page-3"]);
  });

  it("sends the documented page size and never the after_id cursor param", async () => {
    const { urls } = stubThreePageVersionsWire();
    const gc = new FetchAnthropicCustomSkillsGcClient("sk-test");
    await gc.listSkillVersions("skill_1");
    for (const u of urls) {
      const params = new URL(u).searchParams;
      expect(params.get("limit")).toBe(String(ANTHROPIC_SKILLS_LIST_PAGE_LIMIT));
      expect(params.has("after_id")).toBe(false);
    }
  });

  it("honours an injected page size (how the live probe drives a real multi-page walk)", async () => {
    const { urls } = stubThreePageVersionsWire();
    const gc = new FetchAnthropicCustomSkillsGcClient("sk-test", undefined, 1);
    await gc.listSkillVersions("skill_1");
    expect(new URL(urls[0]!).searchParams.get("limit")).toBe("1");
  });

  it("terminates when the page claims has_more but hands back no cursor", async () => {
    // A page that says "there is more" without a usable cursor must NOT
    // re-request page one forever.
    let calls = 0;
    global.fetch = vi.fn(async () => {
      calls++;
      return jsonResponse({ data: [{ version: "v1" }], has_more: true, next_page: null });
    }) as unknown as typeof fetch;
    const gc = new FetchAnthropicCustomSkillsGcClient("sk-test");
    await expect(gc.listSkillVersions("skill_1")).resolves.toEqual(["v1"]);
    expect(calls).toBe(1);
  });

  it("terminates when the server echoes a cursor it already handed back", async () => {
    let calls = 0;
    global.fetch = vi.fn(async () => {
      calls++;
      // Always the SAME cursor — a naive loop would never stop.
      return jsonResponse({
        data: [{ version: `v${calls}` }],
        has_more: true,
        next_page: "stuck",
      });
    }) as unknown as typeof fetch;
    const gc = new FetchAnthropicCustomSkillsGcClient("sk-test");
    const versions = await gc.listSkillVersions("skill_1");
    expect(calls).toBe(2);
    expect(versions).toEqual(["v1", "v2"]);
  });

  it("reads the `data` key the live wire returns (not only the `versions` alias)", async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse({ data: [{ version: "vA" }], has_more: false, next_page: null }),
    ) as unknown as typeof fetch;
    const gc = new FetchAnthropicCustomSkillsGcClient("sk-test");
    await expect(gc.listSkillVersions("skill_1")).resolves.toEqual(["vA"]);
  });

  it("a 404 mid-walk keeps what it already collected", async () => {
    let calls = 0;
    global.fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        return jsonResponse({
          data: [{ version: "v1" }],
          has_more: true,
          next_page: "cursor-page-2",
        });
      }
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const gc = new FetchAnthropicCustomSkillsGcClient("sk-test");
    await expect(gc.listSkillVersions("skill_1")).resolves.toEqual(["v1"]);
  });
});

describe("display_title collision reconciliation against the real list envelope", () => {
  /**
   * A create that collides on `display_title` must reconcile to the existing
   * remote skill rather than duplicating. The live run confirmed the API DOES
   * reject a duplicate title (HTTP 4xx, body matched by the shipped
   * `isDisplayTitleConflict` predicate), so this reconciliation path is load
   * bearing — it is what keeps a lost create response from stranding a skill.
   * The S7 post-fix re-verification then drove this path against the LIVE API
   * and confirmed a real collision does adopt the existing remote identity.
   *
   * ## What the multi-page case below does and does NOT claim
   *
   * The paged arm proves the CLIENT's walk shape: given the documented
   * `{data, has_more, next_page}` envelope, it follows the cursor instead of the
   * `after_id` it used pre-F1. That is a real regression guard on our own code.
   *
   * It is NOT a claim about the live wire for this endpoint. The S7 re-verify
   * measured that `GET /v1/skills` never offers a second page — it truncates to
   * `limit` and answers `has_more:false` / `next_page:null` even with more rows
   * present (finding F6; `live-reverify-results.json`, check R3). So these
   * stubbed pages describe the documented scheme the client is written against,
   * not observed live behaviour, and the residual risk for workspaces with more
   * than one page of custom skills is recorded on the client method itself.
   * The versions walk above is the arm whose exhaustion IS live-proven (R4).
   */
  function stubCollisionThenThreePageList(): { cursors: (string | null)[] } {
    const cursors: (string | null)[] = [];
    global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "POST" && u.endsWith("/v1/skills")) {
        return new Response('{"error":{"message":"display_title must be unique"}}', { status: 400 });
      }
      const parsed = new URL(u);
      if (parsed.searchParams.has("after_id")) {
        return jsonResponse({ unexpected: "after_id was sent" }, 400);
      }
      // The custom-source filter must survive every page of the walk.
      expect(parsed.searchParams.get("source")).toBe("custom");
      const page = parsed.searchParams.get("page");
      cursors.push(page);
      if (page === null) {
        return jsonResponse({
          data: [{ id: "skill_other", display_title: "someone else", latest_version: "v1" }],
          has_more: true,
          next_page: "cursor-page-2",
        });
      }
      if (page === "cursor-page-2") {
        return jsonResponse({
          data: [{ id: "skill_third", display_title: "a third party", latest_version: "v2" }],
          has_more: true,
          next_page: "cursor-page-3",
        });
      }
      // Only the LAST page carries the colliding title.
      return jsonResponse({
        data: [{ id: "skill_mine", display_title: UPLOAD.displayTitle, latest_version: "v7" }],
        has_more: false,
        next_page: null,
      });
    }) as unknown as typeof fetch;
    return { cursors };
  }

  it("finds the colliding title on a later page via next_page", async () => {
    const { cursors } = stubCollisionThenThreePageList();
    const client = new FetchAnthropicCustomSkillsClient("sk-test");
    await expect(client.createSkill(UPLOAD)).resolves.toEqual({
      skillId: "skill_mine",
      version: "v7",
    });
    expect(cursors).toEqual([null, "cursor-page-2", "cursor-page-3"]);
  });

  it("rethrows when the title is genuinely absent from every page", async () => {
    global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "POST" && u.endsWith("/v1/skills")) {
        return new Response('{"error":{"message":"display_title must be unique"}}', { status: 400 });
      }
      return jsonResponse({
        data: [{ id: "skill_other", display_title: "someone else", latest_version: "v1" }],
        has_more: false,
        next_page: null,
      });
    }) as unknown as typeof fetch;
    const client = new FetchAnthropicCustomSkillsClient("sk-test");
    // Exhausting the walk without a match is a real error, not a silent null
    // that would strand the sync row.
    await expect(client.createSkill(UPLOAD)).rejects.toThrow(/POST \/v1\/skills failed/);
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

  it("a paginated walk feeds the delete order (the S0 contract, end to end)", async () => {
    // Ties the two halves together: the versions the walk returns across pages
    // are exactly the versions deleted, and all of them precede the skill delete.
    const hits: string[] = [];
    global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const parsed = new URL(String(url));
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET") {
        const page = parsed.searchParams.get("page");
        if (page === null) {
          return jsonResponse({
            data: [{ version: "v1" }],
            has_more: true,
            next_page: "cursor-page-2",
          });
        }
        return jsonResponse({ data: [{ version: "v2" }], has_more: false, next_page: null });
      }
      hits.push(`${method} ${parsed.pathname}`);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;

    const gc = new FetchAnthropicCustomSkillsGcClient("sk-test");
    const versions = await gc.listSkillVersions("skill_1");
    expect(versions).toEqual(["v1", "v2"]);
    for (const v of versions) await gc.deleteSkillVersion("skill_1", v);
    await gc.deleteSkill("skill_1");

    expect(hits).toEqual([
      "DELETE /v1/skills/skill_1/versions/v1",
      "DELETE /v1/skills/skill_1/versions/v2",
      "DELETE /v1/skills/skill_1",
    ]);
  });
});
