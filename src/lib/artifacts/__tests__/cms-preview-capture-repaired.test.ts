/**
 * cinatra#2044 / #2046 — the REPAIRED capture writer (the repair round trip's
 * THIRD picture).
 *
 * Context this suite exists to lock down: until this writer landed, NO
 * production code path ever wrote a capture with role `repaired`. #2287 shipped
 * the role, the `repair` pair kind and the cross-target loader, so the
 * repair-successor gate rendered "Reviewed / Repaired" with the right half
 * permanently reading "This side was never captured" — for every repair, on
 * every CMS. The live negative proof is recorded on cinatra#2044
 * (issuecomment-5144478834) and #2046 (issuecomment-5144479046).
 *
 * The two properties that carry the fix:
 *   BOUND TO THE SUCCESSOR — every record this writer pins, captured or
 *     degraded, binds to the SUCCESSOR target. Binding the base would overwrite
 *     the reviewed side's own picture and make the comparison a lie.
 *   FAIL-CLOSED HONESTY — the capture must never throw (a repair completes
 *     either way) and must never silently skip: every failure class leaves a
 *     NAMED degraded record so the gate STATES the gap instead of rendering a
 *     one-sided pair. `capture: null` is the one outcome that cannot state it,
 *     and the drain treats exactly that as the loud class.
 */
import { describe, expect, it, vi } from "vitest";

import {
  captureRepairedPreview,
  type CaptureRepairedPreviewInput,
  type PreviewCaptureDeps,
} from "@/lib/artifacts/cms-preview-capture";
import type { StoredPreviewCapture } from "@/lib/artifacts/cms-preview-capture-store";

/** A synthetic Standard-Webhooks key — a TEST FIXTURE, never a credential. */
const SECRET = `whsec_${Buffer.from("cinatra-2044-repaired-capture-test!").toString("base64")}`;

/** A page carrying the site's OWN adapter-marked region, so a proposal has
 * somewhere to be composed into. */
const PAGE = `<html><body><h1 data-cinatra-region="title">Live headline</h1><div data-cinatra-region="content">live body</div></body></html>`;

const SUCCESSOR = { artifactId: "art-successor", revisionId: "rev-successor" };
const BASE = { artifactId: "art-base", revisionId: "rev-base" };

/** A pinned record as `readPinnedCaptures` returns it — only the fields the
 * coordinate recovery reads are meaningful. */
function pinned(
  role: string,
  over: Partial<{ sourceOrigin: string | null; postId: number | null }> = {},
): StoredPreviewCapture {
  return {
    captureArtifactId: `cap-${role}`,
    representationRevisionId: "rev-img",
    data: {
      role,
      status: "captured",
      degradedReason: null,
      boundArtifactId: "art-x",
      boundSnapshotRevisionId: "rev-x",
      sourceOrigin: over.sourceOrigin !== undefined ? over.sourceOrigin : "https://blog.example.com",
      postId: over.postId !== undefined ? over.postId : 42,
      capturedAt: "2026-07-26T10:00:00.000Z",
      geometry: null,
      sanitization: null,
      network: null,
      captureDigest: null,
      title: "t",
      composition: null,
    },
  } as unknown as StoredPreviewCapture;
}

function stubDeps(over: Partial<PreviewCaptureDeps> = {}): {
  deps: PreviewCaptureDeps;
  written: Array<Parameters<PreviewCaptureDeps["writeCapture"]>[0]>;
  rendered: Array<{ html: string }>;
  fetches: Array<{ url: string }>;
  reads: Array<{ boundArtifactId: string; boundSnapshotRevisionId: string }>;
} {
  const written: Array<Parameters<PreviewCaptureDeps["writeCapture"]>[0]> = [];
  const rendered: Array<{ html: string }> = [];
  const fetches: Array<{ url: string }> = [];
  const reads: Array<{ boundArtifactId: string; boundSnapshotRevisionId: string }> = [];
  const deps: PreviewCaptureDeps = {
    listRegisteredSites: async () => [
      { siteId: "site-1", client: "wordpress", origin: "https://blog.example.com" },
    ],
    resolvePreviewSecrets: async () => [SECRET],
    fetchPreview: async ({ url }) => {
      fetches.push({ url });
      return { ok: true, html: PAGE, pinnedAddresses: ["203.0.113.10"] };
    },
    renderIsolated: async ({ html }) => {
      rendered.push({ html });
      return {
        ok: true,
        screenshot: new Uint8Array([137, 80, 78, 71]),
        geometry: {
          regions: [{ region: "content", postId: "42", x: 0, y: 100, width: 640, height: 200 }],
          contentHeight: 1800,
          viewport: { width: 1280, height: 900 },
        },
        network: { blockedRequests: 1, allowedRequests: 2 },
      };
    },
    writeCapture: async (input) => {
      written.push(input);
      return {
        captureArtifactId: "cap-written",
        representationRevisionId: input.screenshot ? "rev-img" : null,
        data: input.data,
      } as StoredPreviewCapture;
    },
    readPinnedCaptures: async (i) => {
      reads.push({
        boundArtifactId: i.boundArtifactId,
        boundSnapshotRevisionId: i.boundSnapshotRevisionId,
      });
      return [];
    },
    now: () => new Date("2026-07-31T09:00:00.000Z"),
    ...over,
  };
  return { deps, written, rendered, fetches, reads };
}

const input: CaptureRepairedPreviewInput = {
  orgId: "org-1",
  boundArtifactId: SUCCESSOR.artifactId,
  boundSnapshotRevisionId: SUCCESSOR.revisionId,
  baseArtifactId: BASE.artifactId,
  baseSnapshotRevisionId: BASE.revisionId,
  proposedFields: { content: "REPAIRED BODY" },
  title: "Repaired post",
};

describe("cinatra#2044 — the `repaired` capture writer", () => {
  it("captures: composes the repaired proposal and pins it BOUND TO THE SUCCESSOR target", async () => {
    // The successor's own re-stage already resolved the site coordinates.
    const { deps, written, rendered } = stubDeps({
      readPinnedCaptures: async () => [pinned("current")],
    });

    const out = await captureRepairedPreview(input, deps);

    expect(out.status).toBe("captured");
    expect(written).toHaveLength(1);
    const record = written[0];
    expect(record.data.role).toBe("repaired");
    expect(record.data.status).toBe("captured");
    // THE binding that makes the pair truthful: the successor, never the base.
    expect(record.data.boundArtifactId).toBe(SUCCESSOR.artifactId);
    expect(record.data.boundSnapshotRevisionId).toBe(SUCCESSOR.revisionId);
    expect(record.data.boundArtifactId).not.toBe(BASE.artifactId);
    // The picture is the REPAIRED proposal composed into the live page's own
    // chrome — the same pipeline the stage-time `current` half uses, which is
    // the only reason the two sides are comparable at all.
    expect(rendered).toHaveLength(1);
    expect(rendered[0].html).toContain("REPAIRED BODY");
    expect(rendered[0].html).not.toContain("live body");
    // The live page's unproposed regions survive untouched.
    expect(rendered[0].html).toContain("Live headline");
    expect(record.data.composition?.substitutedRegions).toEqual(["content"]);
    expect(record.screenshot).toBeInstanceOf(Uint8Array);
    // A preview credential never persists in the record.
    expect(JSON.stringify(record)).not.toContain(SECRET);
  });

  it("recovers the site coordinates from the SUCCESSOR first, then falls back to the BASE target", async () => {
    const reads: string[] = [];
    const { deps } = stubDeps({
      readPinnedCaptures: async (i) => {
        reads.push(i.boundArtifactId);
        // The successor's own pair degraded before it resolved a target; the
        // base target still carries the coordinates for the SAME CMS resource.
        return i.boundArtifactId === BASE.artifactId ? [pinned("current")] : [];
      },
    });

    const out = await captureRepairedPreview(input, deps);

    expect(out.status).toBe("captured");
    expect(reads).toEqual([SUCCESSOR.artifactId, BASE.artifactId]);
  });

  it("never lets a previously pinned DEGRADED `repaired` record stand in for real coordinates", async () => {
    // A degraded record of the role being captured carries no coordinates. If
    // the role filter were wrong, a retry could photograph the wrong page.
    const { deps } = stubDeps({
      readPinnedCaptures: async () => [
        pinned("repaired", { sourceOrigin: "https://attacker.example.com", postId: 9 }),
      ],
    });

    const out = await captureRepairedPreview(input, deps);

    // No usable coordinates from a non-`repaired` role ⇒ the closed denial.
    expect(out.status).toBe("degraded");
    expect(out.status === "degraded" && out.reason).toBe("unusable-source-url");
  });

  it("degrades with a NAMED reason, still bound to the successor, when no coordinates exist anywhere", async () => {
    const { deps, written, fetches } = stubDeps();

    const out = await captureRepairedPreview(input, deps);

    expect(out.status).toBe("degraded");
    expect(out.status === "degraded" && out.reason).toBe("unusable-source-url");
    // Nothing was fetched — a null selector is refused by the policy first.
    expect(fetches).toHaveLength(0);
    // The gate still gets a record that STATES the gap.
    expect(written).toHaveLength(1);
    expect(written[0].data.role).toBe("repaired");
    expect(written[0].data.status).toBe("degraded");
    expect(written[0].data.degradedReason).toBe("unusable-source-url");
    expect(written[0].data.boundArtifactId).toBe(SUCCESSOR.artifactId);
    expect(written[0].data.boundSnapshotRevisionId).toBe(SUCCESSOR.revisionId);
    expect(written[0].screenshot ?? null).toBeNull();
  });

  it("degrades `no-proposed-fields` rather than passing the LIVE page off as the fix", async () => {
    const { deps, written, rendered } = stubDeps({
      readPinnedCaptures: async () => [pinned("current")],
    });

    const out = await captureRepairedPreview({ ...input, proposedFields: null }, deps);

    expect(out.status).toBe("degraded");
    expect(out.status === "degraded" && out.reason).toBe("no-proposed-fields");
    // The live page is NEVER rendered as the repaired picture — that would show
    // the reviewer a page that does not contain the producer's fix and label it
    // "the producer's fix".
    expect(rendered).toHaveLength(0);
    expect(written[0].data.status).toBe("degraded");
    expect(written[0].data.boundArtifactId).toBe(SUCCESSOR.artifactId);
  });

  it("degrades `no-owned-regions` when the site marks none of the repaired fields", async () => {
    const { deps, written, rendered } = stubDeps({
      readPinnedCaptures: async () => [pinned("current")],
      fetchPreview: async () => ({
        ok: true,
        html: `<html><body><p>no marked regions here</p></body></html>`,
        pinnedAddresses: ["203.0.113.10"],
      }),
    });

    const out = await captureRepairedPreview(input, deps);

    expect(out.status).toBe("degraded");
    expect(out.status === "degraded" && out.reason).toBe("no-owned-regions");
    // Showing the base page a second time would imply the fix looks identical.
    expect(rendered).toHaveLength(0);
    expect(written[0].data.degradedReason).toBe("no-owned-regions");
  });

  it("carries a FETCH failure's own named reason onto the record", async () => {
    const { deps, written } = stubDeps({
      readPinnedCaptures: async () => [pinned("current")],
      fetchPreview: async () => ({ ok: false, reason: "preview-unreachable" as const }),
    });

    const out = await captureRepairedPreview(input, deps);

    expect(out.status).toBe("degraded");
    expect(out.status === "degraded" && out.reason).toBe("preview-unreachable");
    expect(written[0].data.degradedReason).toBe("preview-unreachable");
    expect(written[0].data.boundArtifactId).toBe(SUCCESSOR.artifactId);
  });

  it("degrades `render-failed` — and NEVER throws — when the renderer fails", async () => {
    const { deps, written } = stubDeps({
      readPinnedCaptures: async () => [pinned("current")],
      renderIsolated: async () => ({ ok: false, reason: "render-failed" as const }),
    });

    const out = await captureRepairedPreview(input, deps);

    expect(out.status).toBe("degraded");
    expect(out.status === "degraded" && out.reason).toBe("render-failed");
    expect(written[0].data.degradedReason).toBe("render-failed");
  });

  it("NEVER throws when the coordinate read itself throws — it degrades closed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { deps, written } = stubDeps({
        readPinnedCaptures: async () => {
          throw new Error("store is down");
        },
      });

      const out = await captureRepairedPreview(input, deps);

      // A store failure must not surface to the repair — it becomes the same
      // closed, named denial a missing target takes.
      expect(out.status).toBe("degraded");
      expect(out.status === "degraded" && out.reason).toBe("unusable-source-url");
      expect(written[0].data.role).toBe("repaired");
    } finally {
      warn.mockRestore();
    }
  });

  it("reports `capture: null` — the LOUD class — when even the degraded record cannot be written", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { deps } = stubDeps({
        writeCapture: async () => {
          throw new Error("write failed");
        },
      });

      const out = await captureRepairedPreview(input, deps);

      // Still no throw — but the gate cannot state the gap, so the outcome
      // carries `capture: null`, which is exactly what the drain escalates as
      // `repairedCaptureMissing`.
      expect(out.status).toBe("degraded");
      expect(out.capture).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  // ---------------------------------------------------------------------
  // THE IMMUTABLE-RETRY CLASS (a codex convergence finding). The pinned write
  // is immutable — a retry against an already-pinned (target, role) gets the
  // FIRST record back untouched — and the repair drain IS retried whenever its
  // completion did not land. So an outcome that described this ATTEMPT instead
  // of the STORE would misreport the gate in both directions, and the drain
  // acts on exactly these outcomes.
  // ---------------------------------------------------------------------

  it("a retry that RENDERS fine still reports the DEGRADED record the gate actually shows", async () => {
    const { deps } = stubDeps({
      readPinnedCaptures: async () => [pinned("current")],
      // The first attempt already pinned a degraded record; this attempt's own
      // render succeeds, but the store returns the immutable first record.
      writeCapture: async () =>
        ({
          captureArtifactId: "cap-written",
          representationRevisionId: null,
          data: { role: "repaired", status: "degraded", degradedReason: "preview-unreachable" },
        }) as unknown as StoredPreviewCapture,
    });

    const out = await captureRepairedPreview(input, deps);

    // Claiming `captured` here would tell the drain a picture exists while the
    // successor gate still renders the first attempt's stated gap.
    expect(out.status).toBe("degraded");
    expect(out.status === "degraded" && out.reason).toBe("preview-unreachable");
    expect(out.capture).not.toBeNull();
  });

  it("a retry that DEGRADES reports the CAPTURED record already pinned — never a false alarm", async () => {
    const { deps } = stubDeps({
      // No coordinates ⇒ this attempt degrades…
      readPinnedCaptures: async () => [],
      // …but the first attempt's real picture is already pinned.
      writeCapture: async () =>
        ({
          captureArtifactId: "cap-written",
          representationRevisionId: "rev-img",
          data: { role: "repaired", status: "captured", degradedReason: null },
        }) as unknown as StoredPreviewCapture,
    });

    const out = await captureRepairedPreview(input, deps);

    // Reporting the degrade would escalate a missing picture that is right
    // there — the inverse of the bug this whole change exists to fix.
    expect(out.status).toBe("captured");
    expect(out.capture).not.toBeNull();
  });

  it("stamps the accountable principal and the producing run onto the record", async () => {
    const { deps, written } = stubDeps({
      readPinnedCaptures: async () => [pinned("current")],
    });

    await captureRepairedPreview(
      { ...input, createdBy: "user-accountable", producerRunId: "run-repair-1" },
      deps,
    );

    expect(written[0].createdBy).toBe("user-accountable");
    expect(written[0].producerRunId).toBe("run-repair-1");
  });
});
