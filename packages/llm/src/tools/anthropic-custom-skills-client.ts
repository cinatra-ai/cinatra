/**
 * Anthropic Custom Skills HTTP client.
 *
 * VERIFIED API facts (spec §3): `POST /v1/skills` (multipart, <30 MiB — the
 * bound the S7 live acceptance measured) returns a
 * `skill_id` + an immutable epoch `latest_version`; `POST /v1/skills/{id}/versions`
 * creates a NEW immutable version to update. Custom Skills require betas
 * `code-execution-2025-08-25,skills-2025-10-02,files-api-2025-04-14` and are
 * referenced at request time via `container.skills[{type:"custom",skill_id,
 * version}]` together with the `code_execution_20250825` tool. That
 * request-time wiring is handled by `AnthropicContainerSkillDelivery`; this
 * client only uploads.
 *
 * The interface deliberately exposes ONLY `createSkill` + `createSkillVersion`.
 * There is **no delete method** — this structurally enforces the
 * no-remote-GC boundary. A future raw
 * `fetch(..., { method: "DELETE" })` would have to be added explicitly and is
 * caught by the no-DELETE regression test.
 *
 * Pure interface + a `fetch`-based default impl. All unit tests inject a fake
 * client; no live key is required and no test fabricates a live round-trip.
 */

const ANTHROPIC_API_BASE = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";
/** Stacked betas required for Custom Skills (spec §3). */
export const ANTHROPIC_SKILLS_BETAS =
  "code-execution-2025-08-25,skills-2025-10-02,files-api-2025-04-14";

/**
 * Default page size for the two list walks. Both walks paginate to exhaustion
 * regardless of this value; it is injectable purely so a conformance probe can
 * drive a genuinely multi-page walk against the real API without uploading
 * `limit + 1` versions.
 */
export const ANTHROPIC_SKILLS_LIST_PAGE_LIMIT = 100;

/**
 * The list envelope the Skills API actually returns.
 *
 * `{ data, has_more, next_page }` — the forward cursor is the **`page`** query
 * parameter, carrying the opaque `next_page` value. This is the documented
 * Managed-Agents `page`/`next_page` cursor scheme (`GET /v1/skills` is called
 * out by name as a `page`-scheme endpoint that also returns a `has_more`
 * boolean), and it is what the S7 live acceptance captured on the wire
 * (`evidence/2094-s7-acceptance/live-results.json`, checks C3 + C4).
 *
 * There is **no `last_id`** and no `after_id`: the Message Batches / Files /
 * Models endpoints use that other scheme, the Skills endpoints do not. An
 * earlier revision of this client advanced on `has_more` + `last_id` ->
 * `after_id`, which the API never returns, so both walks silently terminated
 * after page one (finding F1 on cinatra#2094).
 */
type SkillsListEnvelope<TRow> = {
  data?: TRow[];
  /** Only the versions endpoint has ever been observed to use this alias. */
  versions?: TRow[];
  has_more?: boolean;
  next_page?: string | null;
};

/**
 * The cursor to request next, or `null` when the walk is complete.
 *
 * Advance ONLY on a non-empty `next_page`, and never when the server has said
 * `has_more: false` — so `{has_more:true, next_page:null}` (a page that claims
 * more but hands back no cursor) terminates rather than re-requesting page one
 * forever.
 */
function nextListPageCursor(body: SkillsListEnvelope<unknown>): string | null {
  if (body.has_more === false) return null;
  const next = body.next_page;
  return typeof next === "string" && next !== "" ? next : null;
}

/**
 * A skill's uploadable payload: the single canonical ZIP artifact rooted at the
 * frontmatter `name` plus the workspace-unique `display_title`. The engine
 * builds + measures the zip once (boundary rule) and hands the exact bytes to
 * the client, so what is measured is byte-identical to what is uploaded.
 */
export type AnthropicSkillUpload = {
  /** Workspace-unique, stable, non-sensitive display title. */
  displayTitle: string;
  /** Common root directory the zip is rooted at (== frontmatter `name`). */
  rootDir: string;
  /** The canonical STORE zip bytes (the single upload artifact). */
  zipBytes: Buffer;
};

export type CreateSkillResult = {
  /** Anthropic-side `skill_xxx` id. */
  skillId: string;
  /** Immutable version string (opaque — no epoch parsing assumed). */
  version: string;
};

export type CreateSkillVersionResult = {
  /** The new immutable version string. */
  version: string;
};

export interface AnthropicCustomSkillsClient {
  /**
   * `POST /v1/skills` — create a new Custom Skill (first upload).
   *
   * IDEMPOTENT by `display_title`: if a custom skill with the upload's
   * (workspace-unique, per-catalog-skill-stable) title already exists — because
   * a prior create's response was lost before the local row persisted — this
   * MUST reconcile to that existing remote skill and return its id + latest
   * version rather than minting a duplicate remote identity.
   */
  createSkill(upload: AnthropicSkillUpload): Promise<CreateSkillResult>;
  /** `POST /v1/skills/{id}/versions` — create a NEW immutable version. */
  createSkillVersion(
    skillId: string,
    upload: AnthropicSkillUpload,
  ): Promise<CreateSkillVersionResult>;
}

/**
 * The documented multipart shape: a `display_title` field plus the skill
 * directory uploaded as ONE zip under the `files[]` field (the API's array
 * field name), rooted at `<rootDir>/…` where `rootDir` matches the SKILL.md
 * frontmatter `name`.
 */
function buildMultipart(upload: AnthropicSkillUpload): FormData {
  const form = new FormData();
  form.set("display_title", upload.displayTitle);
  form.append(
    "files[]",
    new Blob([new Uint8Array(upload.zipBytes)], { type: "application/zip" }),
    `${upload.rootDir}.zip`,
  );
  return form;
}

/**
 * A create failure that means "your `display_title` is already taken". The API
 * returns a 4xx whose body names the `display_title` uniqueness violation; we
 * match conservatively (status + the field name) so only a genuine title
 * collision triggers reconciliation, never an unrelated 400.
 */
export function isDisplayTitleConflict(status: number, detail: string): boolean {
  if (status !== 400 && status !== 409) return false;
  const d = detail.toLowerCase();
  return (
    d.includes("display_title") &&
    (d.includes("unique") ||
      d.includes("already") ||
      d.includes("exist") ||
      d.includes("taken") ||
      d.includes("conflict"))
  );
}

/**
 * The real `fetch`-based client. Constructed by the app layer with the
 * configured Anthropic API key (never logged). Throws on a non-2xx response so
 * the engine surfaces a failure rather than recording a bogus mapping.
 */
export class FetchAnthropicCustomSkillsClient implements AnthropicCustomSkillsClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = ANTHROPIC_API_BASE,
    /** Page size for the collision-reconciliation walk. See {@link ANTHROPIC_SKILLS_LIST_PAGE_LIMIT}. */
    private readonly pageLimit: number = ANTHROPIC_SKILLS_LIST_PAGE_LIMIT,
  ) {}

  private headers(): Record<string, string> {
    return {
      "x-api-key": this.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": ANTHROPIC_SKILLS_BETAS,
    };
  }

  private async post(path: string, upload: AnthropicSkillUpload): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers(),
      body: buildMultipart(upload),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `[anthropic-custom-skills] POST ${path} failed: ${res.status} ${detail.slice(0, 500)}`,
      );
    }
    return res.json();
  }

  async createSkill(upload: AnthropicSkillUpload): Promise<CreateSkillResult> {
    const res = await fetch(`${this.baseUrl}/v1/skills`, {
      method: "POST",
      headers: this.headers(),
      body: buildMultipart(upload),
    });
    if (res.ok) {
      const body = (await res.json()) as {
        id?: string;
        skill_id?: string;
        latest_version?: string;
      };
      const skillId = body.skill_id ?? body.id;
      const version = body.latest_version;
      if (!skillId || !version) {
        throw new Error(
          `[anthropic-custom-skills] createSkill response missing skill_id/latest_version`,
        );
      }
      return { skillId, version };
    }

    const detail = await res.text().catch(() => "");
    // Create-time collision reconciliation: the ONLY reason our stable,
    // per-catalog-skill `display_title` is already taken is a prior create by
    // THIS skill whose response was lost before the row persisted. Adopt that
    // existing remote identity instead of failing (or duplicating). Any OTHER
    // failure is a real error — rethrow.
    if (isDisplayTitleConflict(res.status, detail)) {
      const existing = await this.findCustomSkillByDisplayTitle(upload.displayTitle);
      if (existing) return existing;
    }
    throw new Error(
      `[anthropic-custom-skills] POST /v1/skills failed: ${res.status} ${detail.slice(0, 500)}`,
    );
  }

  /**
   * Paginate `GET /v1/skills?source=custom` to exhaustion and return the id +
   * latest_version of the custom skill whose `display_title` matches exactly, or
   * null. Used ONLY to reconcile a lost create response.
   *
   * Walks the REAL envelope (`{data, has_more, next_page}`, forward cursor on
   * the `page` param — see {@link SkillsListEnvelope}). Exhaustion matters here
   * for the same reason it matters in the GC: a workspace with more custom
   * skills than one page holds would otherwise rethrow the collision instead of
   * adopting the existing remote identity, losing the retry-stability property
   * this reconciliation exists to provide.
   */
  private async findCustomSkillByDisplayTitle(
    displayTitle: string,
  ): Promise<CreateSkillResult | null> {
    let page: string | undefined;
    // A server that echoes a cursor it already handed back would otherwise walk
    // the same page forever; the seen-set makes that terminate.
    const seenCursors = new Set<string>();
    // Bound the walk defensively so a misbehaving `next_page` can never loop.
    for (let i = 0; i < 10_000; i++) {
      const params = new URLSearchParams({
        source: "custom",
        limit: String(this.pageLimit),
      });
      if (page) params.set("page", page);
      const res = await fetch(`${this.baseUrl}/v1/skills?${params.toString()}`, {
        method: "GET",
        headers: this.headers(),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `[anthropic-custom-skills] GET /v1/skills failed: ${res.status} ${detail.slice(0, 500)}`,
        );
      }
      const body = (await res.json()) as SkillsListEnvelope<{
        id?: string;
        display_title?: string;
        latest_version?: string;
      }>;
      const data = body.data ?? [];
      for (const s of data) {
        if (
          s.display_title === displayTitle &&
          typeof s.id === "string" &&
          typeof s.latest_version === "string"
        ) {
          return { skillId: s.id, version: s.latest_version };
        }
      }
      const next = nextListPageCursor(body);
      if (!next || seenCursors.has(next)) return null;
      seenCursors.add(next);
      page = next;
    }
    return null;
  }

  async createSkillVersion(
    skillId: string,
    upload: AnthropicSkillUpload,
  ): Promise<CreateSkillVersionResult> {
    const body = (await this.post(
      `/v1/skills/${encodeURIComponent(skillId)}/versions`,
      upload,
    )) as { version?: string; latest_version?: string };
    const version = body.version ?? body.latest_version;
    if (!version) {
      throw new Error(
        `[anthropic-custom-skills] createSkillVersion response missing version`,
      );
    }
    return { version };
  }
}

// ---------------------------------------------------------------------------
// Delete-capable GC client.
// ---------------------------------------------------------------------------

/**
 * List/delete verbs for reference-counted/leased remote GC.
 *
 * This is a SEPARATE class from {@link FetchAnthropicCustomSkillsClient} on
 * purpose: the sync client interface exposes ONLY create verbs, and
 * that structural no-DELETE boundary (+ its no-DELETE regression test) is the
 * guarantee the sync path can never over-delete. GC delete capability lives
 * here, used ONLY by the explicit/maintenance GC engine, never the sync path.
 *
 * Anthropic ordering (spec §3): a skill cannot be deleted until ALL its
 * versions are deleted first; the GC engine enforces that ordering. A `404`
 * (already gone) is treated as idempotent SUCCESS — a prior interrupted GC may
 * have removed it; it must never wedge a later GC run. Other non-2xx ⇒ throw.
 */
export class FetchAnthropicCustomSkillsGcClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = ANTHROPIC_API_BASE,
    /** Page size for the versions walk. See {@link ANTHROPIC_SKILLS_LIST_PAGE_LIMIT}. */
    private readonly pageLimit: number = ANTHROPIC_SKILLS_LIST_PAGE_LIMIT,
  ) {}

  private headers(): Record<string, string> {
    return {
      "x-api-key": this.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": ANTHROPIC_SKILLS_BETAS,
    };
  }

  /**
   * List EVERY remote version of a skill, paginating the cursor to exhaustion
   * BEFORE the caller deletes any version. A single un-paginated page would
   * leave undeleted versions behind, and the subsequent skill delete would then
   * be REFUSED ("Cannot delete skill with existing versions. Delete all
   * versions first." — the live S7 acceptance confirmed the server enforces
   * that ordering, check C5). The reclaim would then never converge: every run
   * re-deletes the same first page and resurfaces the same refusal.
   *
   * The cursor is the REAL one: `{data, has_more, next_page}` with the forward
   * cursor on the `page` query parameter (see {@link SkillsListEnvelope}) —
   * NOT `last_id`/`after_id`, which this endpoint never returns. This walk
   * reaching exhaustion is the S0 deliverable "paginate `listSkillVersions` to
   * exhaustion before any `deleteSkill`".
   *
   * A 404 means the skill is already gone (idempotent) ⇒ nothing to delete.
   */
  async listSkillVersions(anthropicSkillId: string): Promise<string[]> {
    const out: string[] = [];
    let page: string | undefined;
    // A server that echoes a cursor it already handed back would otherwise walk
    // the same page forever; the seen-set makes that terminate.
    const seenCursors = new Set<string>();
    // Bound the walk defensively so a misbehaving `next_page` can never loop.
    for (let i = 0; i < 10_000; i++) {
      const params = new URLSearchParams({ limit: String(this.pageLimit) });
      if (page) params.set("page", page);
      const res = await fetch(
        `${this.baseUrl}/v1/skills/${encodeURIComponent(anthropicSkillId)}/versions?${params.toString()}`,
        { method: "GET", headers: this.headers() },
      );
      if (res.status === 404) return i === 0 ? [] : out; // skill gone mid-walk
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(
          `[anthropic-custom-skills-gc] GET versions failed: ${res.status} ${detail.slice(0, 500)}`,
        );
      }
      const body = (await res.json()) as SkillsListEnvelope<
        { version?: string } | string
      >;
      // `data` is what the live wire returns; the `versions` alias is kept as a
      // tolerated fallback and is checked SECOND so the observed key wins.
      const list = body.data ?? body.versions ?? [];
      for (const v of list) {
        if (typeof v === "string") out.push(v);
        else if (v && typeof v.version === "string") out.push(v.version);
      }
      const next = nextListPageCursor(body);
      if (!next || seenCursors.has(next)) return out;
      seenCursors.add(next);
      page = next;
    }
    return out;
  }

  private async del(path: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    // 404 / 410 ⇒ already gone ⇒ idempotent success (interrupted prior GC).
    if (res.ok || res.status === 404 || res.status === 410) return;
    const detail = await res.text().catch(() => "");
    throw new Error(
      `[anthropic-custom-skills-gc] DELETE ${path} failed: ${res.status} ${detail.slice(0, 500)}`,
    );
  }

  async deleteSkillVersion(
    anthropicSkillId: string,
    version: string,
  ): Promise<void> {
    await this.del(
      `/v1/skills/${encodeURIComponent(anthropicSkillId)}/versions/${encodeURIComponent(version)}`,
    );
  }

  async deleteSkill(anthropicSkillId: string): Promise<void> {
    await this.del(`/v1/skills/${encodeURIComponent(anthropicSkillId)}`);
  }
}
