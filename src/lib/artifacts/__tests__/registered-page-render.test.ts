/**
 * cinatra#3862 leg 8 l8a1 — the page-render primitives the registered-page
 * capture (cinatra#4223) reads, in their own module after the gate capture
 * pipeline left.
 *
 * The host seams hold no credential and no store: the page capture sends no
 * credential header and files nothing through them. The isolated renderer still
 * refuses to run without the addresses the egress guard validated.
 */
import { describe, expect, it } from "vitest";

import {
  captureDegradeCopy,
  createPreviewCaptureDeps,
  type CaptureDegradeReason,
} from "@/lib/artifacts/registered-page-render";

describe("cinatra#3862 l8a1 — the registered-page render seams", () => {
  it("the real host seams are the four the page capture reads: no credential lookup, no capture store", () => {
    const deps = createPreviewCaptureDeps();
    expect(Object.keys(deps).sort()).toEqual(["fetchPreview", "listRegisteredSites", "now", "renderIsolated"]);
  });

  it("every degrade reason the fetch and the render return has its own copy", () => {
    const reasons: CaptureDegradeReason[] = [
      "egress-blocked",
      "preview-unauthorized",
      "preview-unreachable",
      "preview-bad-response",
      "preview-too-large",
      "sanitization-failed",
      "renderer-unavailable",
      "render-failed",
    ];
    const copies = reasons.map((reason) => captureDegradeCopy(reason));
    for (const copy of copies) expect(copy.length).toBeGreaterThan(0);
    expect(new Set(copies).size).toBe(reasons.length);
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
