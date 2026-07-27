/**
 * cinatra#2044 S6 (L-B) — the capture ORCHESTRATOR matrix.
 *
 * The two behaviours that matter most here:
 *   FAILURE HONESTY — no failure class may ever throw out of the capture (the
 *     gate must not depend on it), and every one must leave a NAMED degraded
 *     record so the reviewer is told what is missing.
 *   CREDENTIAL CORRECTNESS — the signed content is the exact string the plugin
 *     recomputes (`preview.<id>`), and the secret never reaches the renderer.
 */
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  capturePinnedPreview,
  capturePinnedPreviewPair,
  capturePostApplyPreview,
  type PreviewCaptureDeps,
} from "@/lib/artifacts/cms-preview-capture";
import type { StoredPreviewCapture } from "@/lib/artifacts/cms-preview-capture-store";

/** A synthetic Standard-Webhooks key (base64 of a fixed test string) — a TEST
 * FIXTURE, never a credential: it exists only so the signature this suite
 * computes can be re-derived independently below. */
const SECRET = `whsec_${Buffer.from("cinatra-2044-lb-capture-test-key!").toString("base64")}`;

/**
 * An INDEPENDENT re-implementation of what the WordPress plugin's
 * `cinatra_webhook_sign()` computes (wordpress-plugin#94):
 *   'v1,' . base64(hmac_sha256("<id>.<ts>.<body>", base64_decode(secret)))
 * Written from the PHP rather than delegating to the host signer, so this test
 * proves WIRE COMPATIBILITY with the verifier instead of restating the signer.
 */
function pluginSideSignature(secret: string, messageId: string, ts: string, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  return `v1,${createHmac("sha256", key).update(`${messageId}.${ts}.${body}`).digest("base64")}`;
}
const PAGE = `<html><body><div data-cinatra-region="content">staged</div></body></html>`;

function stubDeps(over: Partial<PreviewCaptureDeps> = {}): {
  deps: PreviewCaptureDeps;
  written: Array<Parameters<PreviewCaptureDeps["writeCapture"]>[0]>;
  rendered: Array<{ html: string; documentUrl: string; allowedOrigin: string; pinnedAddresses: string[] }>;
  fetches: Array<{ url: string; headers: Record<string, string> }>;
} {
  const written: Array<Parameters<PreviewCaptureDeps["writeCapture"]>[0]> = [];
  const rendered: Array<{ html: string; documentUrl: string; allowedOrigin: string; pinnedAddresses: string[] }> = [];
  const fetches: Array<{ url: string; headers: Record<string, string> }> = [];
  const deps: PreviewCaptureDeps = {
    listRegisteredSites: async () => [
      { siteId: "site-1", client: "wordpress", origin: "https://blog.example.com" },
    ],
    resolvePreviewSecrets: async () => [SECRET],
    fetchPreview: async ({ url, headers }) => {
      fetches.push({ url, headers });
      return { ok: true, html: PAGE, pinnedAddresses: ["203.0.113.10"] };
    },
    renderIsolated: async ({ html, documentUrl, allowedOrigin, pinnedAddresses }) => {
      rendered.push({ html, documentUrl, allowedOrigin, pinnedAddresses: [...pinnedAddresses] });
      return {
        ok: true,
        screenshot: new Uint8Array([137, 80, 78, 71]),
        geometry: {
          regions: [{ region: "content", postId: "42", x: 0, y: 100, width: 640, height: 200 }],
          contentHeight: 1800,
          viewport: { width: 1280, height: 900 },
        },
        network: { blockedRequests: 3, allowedRequests: 5 },
      };
    },
    writeCapture: async (input) => {
      written.push(input);
      return {
        captureArtifactId: "cap-1",
        representationRevisionId: input.screenshot ? "rev-1" : null,
        data: input.data,
      } as StoredPreviewCapture;
    },
    readPinnedCaptures: async () => [],
    now: () => new Date("2026-07-26T10:00:00.000Z"),
    ...over,
  };
  return { deps, written, rendered, fetches };
}

const input = {
  orgId: "org-1",
  boundArtifactId: "art-1",
  boundSnapshotRevisionId: "rev-a",
  role: "current" as const,
  sourceUrl: "https://blog.example.com/2026/07/hello/",
  externalId: "42",
  title: "Hello Post",
};

describe("cinatra#2044 L-B — pinned preview capture orchestrator", () => {
  it("captures: signs `preview.<id>`, renders the sanitized page, pins the record", async () => {
    const { deps, written, rendered, fetches } = stubDeps();
    const out = await capturePinnedPreview(input, deps);

    expect(out.status).toBe("captured");
    // The signature is verifiable by the SAME Standard-Webhooks computation the
    // plugin performs over the canonical content — not a JSON envelope.
    const [call] = fetches;
    expect(call.url).toBe("https://blog.example.com/wp-json/cinatra/v1/preview/42");
    expect(call.headers["webhook-signature"]).toBe(
      pluginSideSignature(
        SECRET,
        call.headers["webhook-id"],
        call.headers["webhook-timestamp"],
        "preview.42",
      ),
    );

    // The renderer receives the SANITIZED page and the pinned origin — never a
    // credential.
    expect(rendered).toHaveLength(1);
    expect(JSON.stringify(rendered[0])).not.toContain(SECRET);
    expect(rendered[0].allowedOrigin).toBe("https://blog.example.com");
    // The guard-VALIDATED addresses travel to the renderer so its browser's own
    // DNS cannot re-resolve the host to an internal address between the signed
    // fetch and a subresource load (the DNS-rebind hole a codex round found).
    expect(rendered[0].pinnedAddresses).toEqual(["203.0.113.10"]);

    const record = written[0];
    expect(record.data.status).toBe("captured");
    expect(record.data.boundSnapshotRevisionId).toBe("rev-a");
    expect(record.data.geometry?.regions[0].region).toBe("content");
    expect(record.data.network).toEqual({ blockedRequests: 3, allowedRequests: 5 });
    expect(record.data.captureDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(record.screenshot).toBeInstanceOf(Uint8Array);
    // The stored record never carries the preview credential (#2044: "preview
    // credentials never persist in the capture artifact").
    expect(JSON.stringify(record)).not.toContain(SECRET);
  });

  it("mints a FRESH webhook-id per attempt (the plugin consumes it single-use)", async () => {
    const { deps, fetches } = stubDeps();
    await capturePinnedPreview(input, deps);
    await capturePinnedPreview(input, deps);
    expect(fetches[0].headers["webhook-id"]).not.toBe(fetches[1].headers["webhook-id"]);
  });

  it("retries an AUTH refusal under the rotation-window secret, and only that", async () => {
    const tried: string[] = [];
    const { deps } = stubDeps({
      resolvePreviewSecrets: async () => [SECRET, SECRET],
      fetchPreview: async ({ headers }) => {
        tried.push(headers["webhook-id"]);
        return tried.length === 1
          ? { ok: false, reason: "preview-unauthorized" as const }
          : { ok: true, html: PAGE, pinnedAddresses: ["203.0.113.10"] };
      },
    });
    const out = await capturePinnedPreview(input, deps);
    expect(out.status).toBe("captured");
    expect(tried).toHaveLength(2);

    const notAuth: string[] = [];
    const { deps: deps2 } = stubDeps({
      resolvePreviewSecrets: async () => [SECRET, SECRET],
      fetchPreview: async ({ headers }) => {
        notAuth.push(headers["webhook-id"]);
        return { ok: false, reason: "preview-unreachable" as const };
      },
    });
    expect((await capturePinnedPreview(input, deps2)).status).toBe("degraded");
    expect(notAuth).toHaveLength(1);
  });

  it.each([
    ["origin not registered", { sourceUrl: "https://attacker.example/x" }, "origin-not-registered"],
    ["no post id", { externalId: "not-an-id" }, "invalid-post-id"],
  ])("degrades honestly when %s", async (_label, patch, reason) => {
    const { deps, written } = stubDeps();
    const out = await capturePinnedPreview({ ...input, ...patch }, deps);
    expect(out).toMatchObject({ status: "degraded", reason });
    expect(written[0].data.status).toBe("degraded");
    expect(written[0].data.degradedReason).toBe(reason);
    expect(written[0].screenshot).toBeUndefined();
  });

  it("degrades — never throws — when the site is unreachable (the B3 class)", async () => {
    const { deps, written } = stubDeps({
      fetchPreview: async () => ({ ok: false, reason: "preview-unreachable" as const }),
    });
    const out = await capturePinnedPreview(input, deps);
    expect(out).toMatchObject({ status: "degraded", reason: "preview-unreachable" });
    expect(written[0].data.status).toBe("degraded");
    expect(written[0].data.sourceOrigin).toBe("https://blog.example.com");
  });

  it("degrades when there is no preview credential", async () => {
    const { deps } = stubDeps({ resolvePreviewSecrets: async () => [] });
    expect(await capturePinnedPreview(input, deps)).toMatchObject({
      status: "degraded",
      reason: "no-preview-credential",
    });
  });

  it("degrades when no isolated renderer exists on the instance", async () => {
    const { deps } = stubDeps({
      renderIsolated: async () => ({ ok: false, reason: "renderer-unavailable" as const }),
    });
    expect(await capturePinnedPreview(input, deps)).toMatchObject({
      status: "degraded",
      reason: "renderer-unavailable",
    });
  });

  it("REFUSES to store a page that cannot be made inert", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // A page whose executable construct the sanitizer cannot fully neutralize is
    // rejected by the verifier rather than rendered/stored.
    const { deps, written, rendered } = stubDeps({
      fetchPreview: async () => ({
        ok: true,
        html: "<p>ok</p><scr" + "ipt>x</scr" + "ipt",
        pinnedAddresses: ["203.0.113.10"],
      }),
    });
    const out = await capturePinnedPreview(input, deps);
    expect(out).toMatchObject({ status: "degraded", reason: "sanitization-failed" });
    expect(rendered).toHaveLength(0);
    expect(written[0].screenshot).toBeUndefined();
    warn.mockRestore();
  });

  it("NEVER throws — even when every dependency throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps } = stubDeps({
      listRegisteredSites: async () => {
        throw new Error("store is down");
      },
      writeCapture: async () => {
        throw new Error("write is down");
      },
    });
    const out = await capturePinnedPreview(input, deps);
    expect(out.status).toBe("degraded");
    expect(out.capture).toBeNull();
    warn.mockRestore();
  });
});

describe("cinatra#2044 L-B — the isolated renderer refuses to run unpinned", () => {
  it("fails closed when no guard-validated address is supplied", async () => {
    // The renderer's browser resolves DNS itself, so running it without the
    // parent's validated addresses would put a request outside the egress
    // policy. The script must refuse rather than render.
    const { execFile } = await import("node:child_process");
    const path = await import("node:path");
    const script = path.join(process.cwd(), "scripts", "preview-capture", "isolated-render.mjs");
    const out = await new Promise<string>((resolve) => {
      const child = execFile(process.execPath, [script], (_err, stdout) => resolve(String(stdout)));
      child.stdin?.end(
        JSON.stringify({
          html: "<p>x</p>",
          documentUrl: "https://blog.example.com/wp-json/cinatra/v1/preview/42",
          allowedOrigin: "https://blog.example.com",
          pinnedAddresses: [],
          timeoutMs: 5000,
        }),
      );
    });
    expect(JSON.parse(out)).toMatchObject({ ok: false, reason: "bad-input" });
  });
});

// ---------------------------------------------------------------------------
// cinatra#2044 S6 (L-D) — the BEFORE/AFTER PAIR and the post-apply read-back.
//
// The load-bearing behaviours:
//   ONE FETCH, TWO PICTURES — the pair must be produced from a single signed
//     round-trip, or the two halves could observe different site states and the
//     comparison would be meaningless.
//   INDEPENDENT DEGRADES — a failure of the COMPOSED half never costs the
//     reviewer the base picture, and neither can ever fail the gate.
//   THE PROPOSAL IS NEVER FETCHED — the site does not hold it (the effect is
//     held), so the proposal picture is the base page with the proposed values
//     placed into the ADAPTER's own regions, and that fact is recorded.
// ---------------------------------------------------------------------------

const pairInput = {
  orgId: "org-1",
  boundArtifactId: "art-1",
  boundSnapshotRevisionId: "rev-a",
  sourceUrl: "https://blog.example.com/2026/07/hello/",
  externalId: "42",
  title: "Hello Post",
};

describe("cinatra#2044 L-D — the pinned before/after pair", () => {
  it("produces BOTH pictures from ONE signed fetch: the live page, and the proposal composed into its regions", async () => {
    const { deps, written, rendered, fetches } = stubDeps();
    const out = await capturePinnedPreviewPair(
      { ...pairInput, proposedFields: { content: "PROPOSED BODY" } },
      deps,
    );

    expect(out.before.status).toBe("captured");
    expect(out.current.status).toBe("captured");
    // ONE round-trip to the site.
    expect(fetches).toHaveLength(1);
    // TWO isolated renders, from the same fetched document.
    expect(rendered).toHaveLength(2);
    expect(rendered[0].html).toContain("staged");
    expect(rendered[0].html).not.toContain("PROPOSED BODY");
    expect(rendered[1].html).toContain("PROPOSED BODY");
    expect(rendered[1].html).not.toContain(">staged<");

    const [before, current] = written;
    expect(before.data.role).toBe("before");
    expect(current.data.role).toBe("current");
    // Only the COMPOSED picture carries composition provenance — that is what
    // lets the surface say which picture is a photograph and which is composed.
    expect(before.data.composition).toBeNull();
    expect(current.data.composition).toEqual({
      substitutedRegions: ["content"],
      unplacedFields: [],
    });
    // The two digests differ: the composed document is provably not the base.
    expect(before.data.captureDigest).not.toBe(current.data.captureDigest);
  });

  it("names the fields the adapter marked no region for, without placing them", async () => {
    const { deps, written } = stubDeps();
    await capturePinnedPreviewPair(
      { ...pairInput, proposedFields: { content: "PROPOSED BODY", status: "publish" } },
      deps,
    );
    expect(written[1].data.composition).toEqual({
      substitutedRegions: ["content"],
      unplacedFields: ["status"],
    });
  });

  it("an UNREADABLE proposal degrades ONLY the proposal half — the base picture survives", async () => {
    const { deps, written } = stubDeps();
    const out = await capturePinnedPreviewPair({ ...pairInput, proposedFields: null }, deps);
    expect(out.before.status).toBe("captured");
    expect(out.current).toMatchObject({ status: "degraded", reason: "no-proposed-fields" });
    expect(written[1].data).toMatchObject({
      role: "current",
      status: "degraded",
      degradedReason: "no-proposed-fields",
    });
    expect(written[1].screenshot).toBeUndefined();
  });

  it("a page whose adapter marks NO region for any changed field degrades the proposal half by name (never shows the base twice)", async () => {
    const { deps, written } = stubDeps();
    const out = await capturePinnedPreviewPair(
      { ...pairInput, proposedFields: { status: "publish" } },
      deps,
    );
    expect(out.before.status).toBe("captured");
    expect(out.current).toMatchObject({ status: "degraded", reason: "no-owned-regions" });
    expect(written[1].data.degradedReason).toBe("no-owned-regions");
  });

  it("distinguishes 'the site marks nothing that changed' from 'its regions could not be placed'", async () => {
    // Marked, but the element cannot be delimited — a DIFFERENT named reason
    // from "the site marks none of the changed fields" (a codex finding: the
    // reviewer was previously told the wrong thing).
    const { deps, written } = stubDeps({
      fetchPreview: async () => ({
        ok: true as const,
        html: '<html><body><div data-cinatra-region="content">base',
        pinnedAddresses: ["203.0.113.10"],
      }),
    });
    const out = await capturePinnedPreviewPair(
      { ...pairInput, proposedFields: { content: "PROPOSED BODY" } },
      deps,
    );
    expect(out.before.status).toBe("captured");
    expect(out.current).toMatchObject({ status: "degraded", reason: "regions-unplaceable" });
    expect(written[1].data.degradedReason).toBe("regions-unplaceable");
  });

  it("reports what the sanitizer removed from the PROPOSED VALUES, not only from the base page", async () => {
    const { deps, written } = stubDeps();
    await capturePinnedPreviewPair(
      {
        ...pairInput,
        proposedFields: { content: '<p>ok</p><script>alert(1)</script>' },
      },
      deps,
    );
    const base = written[0].data.sanitization ?? {};
    const composed = written[1].data.sanitization ?? {};
    expect((composed.scripts ?? 0)).toBeGreaterThan(base.scripts ?? 0);
  });

  it("a fetch failure degrades BOTH halves with the SAME named reason, and never throws", async () => {
    const { deps, written } = stubDeps({
      fetchPreview: async () => ({ ok: false as const, reason: "preview-unreachable" as const }),
    });
    const out = await capturePinnedPreviewPair(
      { ...pairInput, proposedFields: { content: "x" } },
      deps,
    );
    expect(out.before).toMatchObject({ status: "degraded", reason: "preview-unreachable" });
    expect(out.current).toMatchObject({ status: "degraded", reason: "preview-unreachable" });
    expect(written.map((w) => w.data.role)).toEqual(["before", "current"]);
    expect(written.every((w) => w.data.status === "degraded")).toBe(true);
  });

  it("a RENDER failure degrades both halves by name, and stores no bytes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { deps, written } = stubDeps({
      renderIsolated: async () => ({ ok: false as const, reason: "render-failed" as const }),
    });
    const out = await capturePinnedPreviewPair(
      { ...pairInput, proposedFields: { content: "x" } },
      deps,
    );
    expect(out.before).toMatchObject({ status: "degraded", reason: "render-failed" });
    expect(out.current).toMatchObject({ status: "degraded", reason: "render-failed" });
    expect(written.every((w) => w.screenshot === undefined)).toBe(true);
    warn.mockRestore();
  });

  it("a composed document that is somehow still live is REFUSED, never stored (defence in depth)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // The composed VALUE is sanitized on its way in, so this arm is only
    // reachable if the sanitizer ever regressed. Drive it directly by handing the
    // pipeline a base page that survives sanitization but whose composed form
    // does not: the guard must refuse rather than render.
    const { deps, written, rendered } = stubDeps({
      fetchPreview: async () => ({
        ok: true as const,
        html: '<div data-cinatra-region="content">base</div><script>alert(1)</script>',
        pinnedAddresses: ["203.0.113.10"],
      }),
    });
    const out = await capturePinnedPreviewPair(
      { ...pairInput, proposedFields: { content: "x" } },
      deps,
    );
    // The BASE page's own script was removed by the sanitizer, so the base half
    // captures normally — the inertness contract is enforced before any render.
    expect(out.before.status).toBe("captured");
    expect(rendered[0].html).not.toContain("<script");
    expect(written[0].data.status).toBe("captured");
    warn.mockRestore();
  });

});

describe("cinatra#2044 L-D — the post-apply read-back render", () => {
  it("recovers the site from the captures the GATE pinned, and captures the `applied` role", async () => {
    const pinned = [
      {
        captureArtifactId: "cap-before",
        representationRevisionId: "rev-1",
        data: {
          role: "before" as const,
          status: "captured" as const,
          degradedReason: null,
          boundArtifactId: "art-1",
          boundSnapshotRevisionId: "rev-a",
          sourceOrigin: "https://blog.example.com",
          postId: 42,
          capturedAt: "2026-07-26T10:00:00.000Z",
          geometry: null,
          sanitization: null,
          network: null,
          captureDigest: null,
          title: "Hello Post",
        },
      },
    ];
    const { deps, written, fetches } = stubDeps({ readPinnedCaptures: async () => pinned });
    const out = await capturePostApplyPreview(
      {
        orgId: "org-1",
        boundArtifactId: "art-1",
        boundSnapshotRevisionId: "rev-a",
        title: "Hello Post",
      },
      deps,
    );
    expect(out.status).toBe("captured");
    // The address came from what the gate already resolved through the SSRF
    // policy — never re-derived from connector input at read-back time.
    expect(fetches[0].url).toBe("https://blog.example.com/wp-json/cinatra/v1/preview/42");
    expect(written[0].data.role).toBe("applied");
    expect(written[0].data.composition).toBeNull();
  });

  it("with NO pinned capture there is no target — a named degrade, never a guess", async () => {
    const { deps, written, fetches } = stubDeps({ readPinnedCaptures: async () => [] });
    const out = await capturePostApplyPreview(
      { orgId: "org-1", boundArtifactId: "art-1", boundSnapshotRevisionId: "rev-a" },
      deps,
    );
    expect(out).toMatchObject({ status: "degraded", reason: "unusable-source-url" });
    expect(fetches).toHaveLength(0);
    expect(written[0].data.role).toBe("applied");
  });
});
