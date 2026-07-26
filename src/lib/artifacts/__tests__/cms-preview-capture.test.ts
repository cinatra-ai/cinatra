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
