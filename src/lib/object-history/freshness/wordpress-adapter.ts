// WordPress reference freshness adapter.
//
// Probes the WordPress REST API for the captured remote post and
// determines whether it's fresh (matches the snapshot), changed (remote
// edited since capture), missing (deleted), unsupported (instance not
// configured), or unknown (network/transient).
//
// Comparison: modified_gmt timestamp + content_hash (sha256 of rendered
// content). modified_gmt alone is unstable across some plugin updates;
// the content hash provides a second signal.

import { createHash } from "node:crypto";

import {
  type FreshnessAdapter,
  type FreshnessState,
} from "./contract";
import {
  type WordPressInstanceSettings,
  readWordPressInstanceById,
} from "@/lib/wordpress-api";

// Direct WP REST call. We don't reuse readWordPressPost because it doesn't
// surface modified_gmt and throws on 404 — for freshness we want a soft
// 404→missing.
async function fetchPostStatus(
  instance: WordPressInstanceSettings,
  remoteId: string,
  postType: string,
): Promise<
  | {
      ok: true;
      modifiedGmt: string | null;
      contentHash: string;
      contentRaw: string;
    }
  | { ok: false; status: number }
> {
  const auth = await resolveAuthHeader(instance);
  const restPath = postType === "page" ? `pages/${remoteId}` : `posts/${remoteId}`;
  const siteUrl = String(instance.siteUrl).replace(/\/$/, "");
  const url = `${siteUrl}/wp-json/wp/v2/${restPath}?context=edit`;
  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: auth,
      Accept: "application/json",
    },
    cache: "no-store",
  });
  if (response.status === 404) {
    return { ok: false, status: 404 };
  }
  if (!response.ok) {
    return { ok: false, status: response.status };
  }
  const json = (await response.json()) as {
    id?: number;
    modified_gmt?: string;
    content?: { rendered?: string; raw?: string };
  };
  const contentRaw = json.content?.raw ?? json.content?.rendered ?? "";
  const contentHash = createHash("sha256").update(contentRaw).digest("hex");
  return {
    ok: true,
    modifiedGmt: json.modified_gmt ?? null,
    contentHash,
    contentRaw,
  };
}

async function resolveAuthHeader(
  instance: WordPressInstanceSettings,
): Promise<string> {
  // Use the same Basic-auth scheme as wordpress-api.ts. For brevity we
  // build it here; if instance.appPassword is unavailable we throw which
  // surfaces as "unknown" in the freshness verdict (caught by the adapter).
  const user = String((instance as Record<string, unknown>).username ?? "admin");
  const pass = String(
    (instance as Record<string, unknown>).appPassword ??
      (instance as Record<string, unknown>).applicationPassword ??
      "",
  );
  if (!pass) {
    throw new Error("WordPress instance has no application password configured");
  }
  const token = Buffer.from(`${user}:${pass}`).toString("base64");
  return `Basic ${token}`;
}

export const wordpressFreshnessAdapter: FreshnessAdapter = {
  connectorName: "wordpress",
  async check({ remoteRevisionRef }): Promise<FreshnessState> {
    if (
      !remoteRevisionRef ||
      remoteRevisionRef.connector !== "wordpress" ||
      !remoteRevisionRef.remoteId
    ) {
      // The local object isn't WordPress-tagged at all.
      return { state: "unsupported" };
    }
    // Resolve the WordPress instance. RemoteRevisionRef carries `extra`
    // metadata; we expect `instanceId` to be present so we can look up
    // credentials. If absent, the adapter is unsupported for this row.
    const ref = remoteRevisionRef as unknown as {
      connector: string;
      kind: string;
      remoteId: string;
      revisionId?: string;
      modifiedAt?: string;
      extra?: { instanceId?: string; postType?: string; contentHash?: string };
    };
    const instanceId = ref.extra?.instanceId;
    if (!instanceId) {
      return {
        state: "unknown",
        reason: "remoteRevisionRef missing extra.instanceId",
      };
    }
    let instance: WordPressInstanceSettings | null = null;
    try {
      instance = (await readWordPressInstanceById(instanceId)) as
        | WordPressInstanceSettings
        | null;
    } catch (_e) {
      return {
        state: "unknown",
        reason: "wordpress instance lookup failed",
      };
    }
    if (!instance) return { state: "unknown", reason: "wordpress instance not found" };

    let probe;
    try {
      probe = await fetchPostStatus(
        instance,
        ref.remoteId,
        ref.extra?.postType ?? "post",
      );
    } catch (e) {
      return {
        state: "unknown",
        reason: `wordpress probe failed: ${(e as Error).message}`,
      };
    }
    if (!probe.ok) {
      if (probe.status === 404) return { state: "missing" };
      return {
        state: "unknown",
        reason: `wordpress probe returned ${probe.status}`,
      };
    }
    // Compare modified_gmt + content hash against what we captured.
    const capturedModifiedAt = ref.modifiedAt;
    const capturedContentHash = ref.extra?.contentHash;
    const baseRevision = probe.modifiedGmt ?? probe.contentHash;
    if (capturedModifiedAt && probe.modifiedGmt) {
      // ISO/timestamp comparison — if they don't match, remote was edited.
      if (capturedModifiedAt !== probe.modifiedGmt) {
        return {
          state: "changed",
          baseRevision,
          changedFields: ["content"],
        };
      }
    }
    if (capturedContentHash && capturedContentHash !== probe.contentHash) {
      return {
        state: "changed",
        baseRevision,
        changedFields: ["content"],
      };
    }
    if (!capturedModifiedAt && !capturedContentHash) {
      // We have nothing to compare against. Return unknown rather than
      // pretending fresh.
      return {
        state: "unknown",
        reason: "no captured modifiedAt or contentHash in remoteRevisionRef",
      };
    }
    return { state: "fresh", baseRevision };
  },
};
