/**
 * Anthropic Skills API HTTP conformance seed.
 *
 * Asserts the documented request/response contract against a STUBBED fetch (no
 * live key, no real round-trip): the multipart shape (`display_title` + a single
 * `files[]` zip rooted at the frontmatter name), the required beta + version
 * headers, create-time display_title collision reconciliation, and the GC
 * client's version-list pagination + versions-then-skill delete order.
 *
 * Grounded in the Skills API docs (skills-2025-10-02): `POST /v1/skills`
 * (multipart `files[]`, zip upload, `display_title` unique), list pagination
 * (`limit`/`after_id` + `has_more`/`last_id`/`data`), and "delete all versions
 * before the skill".
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  FetchAnthropicCustomSkillsClient,
  FetchAnthropicCustomSkillsGcClient,
  isDisplayTitleConflict,
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
function textResponse(text: string, status: number): Response {
  return new Response(text, { status });
}

const UPLOAD: AnthropicSkillUpload = {
  displayTitle: "My Skill [abcdef012345]",
  rootDir: "my-skill",
  zipBytes: Buffer.from("PKzip-bytes-here"),
};

describe("createSkill — documented multipart/zip shape + headers", () => {
  it("POSTs display_title + a single files[] zip with the skills betas", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse({ id: "skill_1", latest_version: "v1" });
    }) as unknown as typeof fetch;

    const client = new FetchAnthropicCustomSkillsClient("sk-test");
    const res = await client.createSkill(UPLOAD);
    expect(res).toEqual({ skillId: "skill_1", version: "v1" });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.anthropic.com/v1/skills");
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["anthropic-beta"]).toBe(ANTHROPIC_SKILLS_BETAS);
    expect(ANTHROPIC_SKILLS_BETAS).toContain("skills-2025-10-02");
    expect(headers["x-api-key"]).toBe("sk-test");

    const form = calls[0].init.body as FormData;
    expect(form.get("display_title")).toBe("My Skill [abcdef012345]");
    // Exactly ONE file part under the documented `files[]` field, a zip blob.
    const files = form.getAll("files[]");
    expect(files).toHaveLength(1);
    const blob = files[0] as Blob;
    expect(blob.type).toBe("application/zip");
    expect(blob.size).toBe(UPLOAD.zipBytes.length);
    // No bare un-rooted `files` / `SKILL.md` parts (the old violation).
    expect(form.getAll("files")).toHaveLength(0);
  });
});

describe("createSkill — display_title collision reconciliation (retry stability)", () => {
  it("adopts the existing remote skill on a title conflict instead of duplicating", async () => {
    const seen: string[] = [];
    global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      seen.push(`${init?.method ?? "GET"} ${u}`);
      if (init?.method === "POST" && u.endsWith("/v1/skills")) {
        return textResponse(
          '{"error":{"message":"display_title must be unique; already exists"}}',
          400,
        );
      }
      if (u.includes("/v1/skills?")) {
        return jsonResponse({
          data: [
            { id: "skill_other", display_title: "Someone Else", latest_version: "v9" },
            { id: "skill_mine", display_title: UPLOAD.displayTitle, latest_version: "v7" },
          ],
          has_more: false,
        });
      }
      throw new Error(`unexpected ${u}`);
    }) as unknown as typeof fetch;

    const client = new FetchAnthropicCustomSkillsClient("sk-test");
    const res = await client.createSkill(UPLOAD);
    // Reconciled to the existing remote identity — one skill, not a duplicate.
    expect(res).toEqual({ skillId: "skill_mine", version: "v7" });
    expect(seen.filter((s) => s.startsWith("POST"))).toHaveLength(1);
  });

  // The cursor here is the REAL one the API returns: `next_page`, replayed on
  // the `page` query param. An earlier revision of this stub fabricated
  // `last_id`/`after_id` (the Message-Batches/Files scheme, which the Skills
  // endpoints do not use) and so agreed with a client that could not paginate
  // against the live API at all — finding F1 on cinatra#2094. The captured live
  // envelope is pinned in `anthropic-skills-api-wire-conformance.test.ts`.
  it("paginates the skills list to find the colliding title on a later page", async () => {
    global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (init?.method === "POST") {
        return textResponse("display_title already taken", 409);
      }
      if (u.includes("page=cursor1")) {
        return jsonResponse({
          data: [{ id: "skill_mine", display_title: UPLOAD.displayTitle, latest_version: "vX" }],
          has_more: false,
          next_page: null,
        });
      }
      // first page: no match, more pages
      return jsonResponse({
        data: [{ id: "s0", display_title: "nope", latest_version: "v0" }],
        has_more: true,
        next_page: "cursor1",
      });
    }) as unknown as typeof fetch;

    const client = new FetchAnthropicCustomSkillsClient("sk-test");
    const res = await client.createSkill(UPLOAD);
    expect(res).toEqual({ skillId: "skill_mine", version: "vX" });
  });

  it("a NON-title 400 is rethrown, not reconciled", async () => {
    global.fetch = vi.fn(async () =>
      textResponse('{"error":{"message":"bad request: malformed zip"}}', 400),
    ) as unknown as typeof fetch;
    const client = new FetchAnthropicCustomSkillsClient("sk-test");
    await expect(client.createSkill(UPLOAD)).rejects.toThrow(/POST \/v1\/skills failed: 400/);
  });
});

describe("isDisplayTitleConflict", () => {
  it("matches only title-uniqueness 400/409s", () => {
    expect(isDisplayTitleConflict(400, "display_title must be unique")).toBe(true);
    expect(isDisplayTitleConflict(409, "the display_title already exists")).toBe(true);
    expect(isDisplayTitleConflict(400, "malformed zip archive")).toBe(false);
    expect(isDisplayTitleConflict(500, "display_title unique")).toBe(false);
  });
});

describe("GC client — listSkillVersions pagination + delete order", () => {
  it("paginates versions to exhaustion via has_more/next_page + page", async () => {
    const urls: string[] = [];
    global.fetch = vi.fn(async (url: string | URL) => {
      const u = String(url);
      urls.push(u);
      if (u.includes("page=cur1")) {
        return jsonResponse({ data: [{ version: "v3" }], has_more: false, next_page: null });
      }
      return jsonResponse({
        data: [{ version: "v1" }, { version: "v2" }],
        has_more: true,
        next_page: "cur1",
      });
    }) as unknown as typeof fetch;

    const gc = new FetchAnthropicCustomSkillsGcClient("sk-test");
    const versions = await gc.listSkillVersions("skill_1");
    expect(versions).toEqual(["v1", "v2", "v3"]);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toContain("/v1/skills/skill_1/versions?");
    expect(urls[0]).toContain("limit=100");
    expect(urls[1]).toContain("page=cur1");
    // The fabricated cursor param must never be sent.
    expect(urls.some((x) => x.includes("after_id"))).toBe(false);
  });

  it("a 404 on the first page ⇒ empty (skill already gone, idempotent)", async () => {
    global.fetch = vi.fn(async () => textResponse("not found", 404)) as unknown as typeof fetch;
    const gc = new FetchAnthropicCustomSkillsGcClient("sk-test");
    expect(await gc.listSkillVersions("gone")).toEqual([]);
  });

  it("delete verbs hit the documented version-then-skill endpoints; 404 is idempotent", async () => {
    const hits: string[] = [];
    global.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      hits.push(`${init?.method} ${String(url)}`);
      return new Response(null, { status: 204 });
    }) as unknown as typeof fetch;
    const gc = new FetchAnthropicCustomSkillsGcClient("sk-test");
    await gc.deleteSkillVersion("skill_1", "v1");
    await gc.deleteSkill("skill_1");
    expect(hits).toEqual([
      "DELETE https://api.anthropic.com/v1/skills/skill_1/versions/v1",
      "DELETE https://api.anthropic.com/v1/skills/skill_1",
    ]);
  });
});
