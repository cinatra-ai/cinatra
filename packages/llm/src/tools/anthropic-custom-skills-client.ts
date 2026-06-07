/**
 * Anthropic Custom Skills HTTP client.
 *
 * VERIFIED API facts (spec §3): `POST /v1/skills` (multipart, <30MB) returns a
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

/** A skill's uploadable payload: the SKILL.md body + its bundled files. */
export type AnthropicSkillUpload = {
  /** Display name (the catalog skill name). */
  displayName: string;
  /** Raw SKILL.md bytes. */
  skillMd: Buffer;
  /** Bundled files, POSIX relPath + raw bytes. */
  bundledFiles: { relPath: string; bytes: Buffer }[];
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
  /** `POST /v1/skills` — create a new Custom Skill (first upload). */
  createSkill(upload: AnthropicSkillUpload): Promise<CreateSkillResult>;
  /** `POST /v1/skills/{id}/versions` — create a NEW immutable version. */
  createSkillVersion(
    skillId: string,
    upload: AnthropicSkillUpload,
  ): Promise<CreateSkillVersionResult>;
}

function buildMultipart(upload: AnthropicSkillUpload): FormData {
  const form = new FormData();
  form.set("display_title", upload.displayName);
  // SKILL.md is the skill entrypoint.
  form.append(
    "files",
    new Blob([new Uint8Array(upload.skillMd)], { type: "text/markdown" }),
    "SKILL.md",
  );
  for (const f of upload.bundledFiles) {
    form.append(
      "files",
      new Blob([new Uint8Array(f.bytes)], { type: "application/octet-stream" }),
      f.relPath,
    );
  }
  return form;
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
    const body = (await this.post("/v1/skills", upload)) as {
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
  ) {}

  private headers(): Record<string, string> {
    return {
      "x-api-key": this.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-beta": ANTHROPIC_SKILLS_BETAS,
    };
  }

  async listSkillVersions(anthropicSkillId: string): Promise<string[]> {
    const res = await fetch(
      `${this.baseUrl}/v1/skills/${encodeURIComponent(anthropicSkillId)}/versions`,
      { method: "GET", headers: this.headers() },
    );
    if (res.status === 404) return []; // skill already gone ⇒ nothing to delete
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(
        `[anthropic-custom-skills-gc] GET versions failed: ${res.status} ${detail.slice(0, 500)}`,
      );
    }
    const body = (await res.json()) as {
      versions?: Array<{ version?: string } | string>;
      data?: Array<{ version?: string } | string>;
    };
    const list = body.versions ?? body.data ?? [];
    const out: string[] = [];
    for (const v of list) {
      if (typeof v === "string") out.push(v);
      else if (v && typeof v.version === "string") out.push(v.version);
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
