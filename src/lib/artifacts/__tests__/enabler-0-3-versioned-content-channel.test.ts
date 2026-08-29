/**
 * ENABLER 0.3 — the versioned server content channel. The contract-level
 * acceptance test the plan requires ("Every enabler carries a contract-level
 * acceptance test in the host's suite", §8.8), for cinatra#3027 / epic #3023.
 *
 * THE ENABLER'S OWN SENTENCE, which every case below serves:
 *   "The versioned server content channel: a discriminated projection with
 *   caps, an asynchronous props builder that reads the pinned revision on the
 *   server, and a size assertion at the serialization boundary — carrying one
 *   projection per content class — text for text forms, configuration for
 *   platform-state types, and a versioned page projection for remote-content
 *   types — each a contract defined here."
 */
import { describe, expect, it } from "vitest";

import {
  ARTIFACT_CONTENT_CHANNEL_CAPS,
  ARTIFACT_CONTENT_CHANNEL_VERSION,
  assertContentProjectionWithinCap,
  buildArtifactContentProjection,
  resolveArtifactContentClass,
  truncateToUtf8Bytes,
  type ArtifactContentChannelPorts,
} from "@/lib/artifacts/artifact-content-channel";
import {
  ARTIFACT_CONTENT_CHANNEL_CAPS_MIRROR,
  ARTIFACT_CONTENT_CHANNEL_VERSION as HOST_MIRRORED_CHANNEL_VERSION,
  absentArtifactContent,
  assertSerializableRendererProps,
  type ArtifactRendererProps,
} from "@/lib/artifacts/artifact-renderer-props";

const ORG = "org-3027";
const ART = "artifact-3027";
const REV = "rev-3027";

function ports(substance: Parameters<ArtifactContentChannelPorts["readPinnedSubstance"]> extends never ? never : Awaited<ReturnType<ArtifactContentChannelPorts["readPinnedSubstance"]>>): ArtifactContentChannelPorts & { calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    readPinnedSubstance: (input) => {
      calls.push(input);
      return substance;
    },
  };
}

describe("enabler 0.3 — one projection per content class", () => {
  it("resolves the three classes from the substrate's FORM, never from a guess", () => {
    // "text for text forms"
    expect(resolveArtifactContentClass({ form: "file", mime: "text/markdown" })).toBe("text");
    expect(resolveArtifactContentClass({ form: "file", mime: "text/plain; charset=utf-8" })).toBe("text");
    expect(resolveArtifactContentClass({ form: "file", mime: "application/json" })).toBe("text");
    // "configuration for platform-state types"
    expect(resolveArtifactContentClass({ form: "dashboard", mime: "application/vnd.cinatra.dashboard+json" })).toBe("configuration");
    // "a versioned page projection for remote-content types"
    expect(resolveArtifactContentClass({ form: "connectorRef", mime: "text/html" })).toBe("page");
  });

  it("gives a binary file NO content class — its bytes take the byte capability, not this channel", () => {
    expect(resolveArtifactContentClass({ form: "file", mime: "image/png" })).toBeNull();
    expect(resolveArtifactContentClass({ form: "file", mime: "application/pdf" })).toBeNull();
    // text on the wire is not prose: svg carries active markup and must never
    // reach a display as a decoded string.
    expect(resolveArtifactContentClass({ form: "file", mime: "image/svg+xml" })).toBeNull();
  });
});

describe("enabler 0.3 — the asynchronous builder reads the PINNED revision", () => {
  it("passes the exact pinned revision to the read and carries it back on the projection", async () => {
    const p = ports({ class: "text", text: "# draft" });
    const projection = await buildArtifactContentProjection(
      { orgId: ORG, artifactId: ART, representationRevisionId: REV, form: "file", mime: "text/markdown" },
      p,
    );
    expect(p.calls).toEqual([
      { orgId: ORG, artifactId: ART, representationRevisionId: REV, contentClass: "text" },
    ]);
    expect(projection).toMatchObject({
      kind: "text",
      channelVersion: ARTIFACT_CONTENT_CHANNEL_VERSION,
      representationRevisionId: REV,
      text: "# draft",
      encoding: "utf-8",
      truncated: false,
    });
  });

  it("projects a configuration with its digest, and a page with its OWN version", async () => {
    const cfg = await buildArtifactContentProjection(
      { orgId: ORG, artifactId: ART, representationRevisionId: REV, form: "dashboard", mime: "application/vnd.cinatra.dashboard+json" },
      ports({ class: "configuration", configuration: { portlets: [] }, digest: "abc123" }),
    );
    expect(cfg).toMatchObject({ kind: "configuration", digest: "abc123", configuration: { portlets: [] } });

    const page = await buildArtifactContentProjection(
      { orgId: ORG, artifactId: ART, representationRevisionId: REV, form: "connectorRef", mime: "text/html" },
      ports({ class: "page", pageVersion: 3, page: { title: "t" } }),
    );
    expect(page).toMatchObject({ kind: "page", pageVersion: 3, channelVersion: ARTIFACT_CONTENT_CHANNEL_VERSION });
  });

  it("names every absence instead of shipping an empty string", async () => {
    const noRevision = await buildArtifactContentProjection(
      { orgId: ORG, artifactId: ART, representationRevisionId: null, form: null, mime: null },
      ports(null),
    );
    expect(noRevision).toMatchObject({ kind: "none", reason: "absent", representationRevisionId: null });

    const binary = await buildArtifactContentProjection(
      { orgId: ORG, artifactId: ART, representationRevisionId: REV, form: "file", mime: "image/png" },
      ports(null),
    );
    expect(binary).toMatchObject({ kind: "none", reason: "unsupported-form" });

    const unreadable = await buildArtifactContentProjection(
      { orgId: ORG, artifactId: ART, representationRevisionId: REV, form: "file", mime: "text/plain" },
      ports(null),
    );
    expect(unreadable).toMatchObject({ kind: "none", reason: "absent" });
  });
});

describe("enabler 0.3 — the channel version is mirrored on the props contract", () => {
  it("keeps the host props contract's mirrored channel version in lockstep with the SDK leaf", () => {
    // The props contract deliberately imports nothing at value level (four
    // locked route graphs reach it), so it MIRRORS this integer. The two must
    // never drift.
    expect(HOST_MIRRORED_CHANNEL_VERSION).toBe(ARTIFACT_CONTENT_CHANNEL_VERSION);
  });

  it("names the absence with that same version", () => {
    expect(absentArtifactContent("rev-1")).toEqual({
      kind: "none",
      channelVersion: ARTIFACT_CONTENT_CHANNEL_VERSION,
      representationRevisionId: "rev-1",
      reason: "absent",
    });
    expect(absentArtifactContent(null, "unsupported-form")).toMatchObject({
      kind: "none",
      reason: "unsupported-form",
      representationRevisionId: null,
    });
  });
});

describe("enabler 0.3 — the caps, and the assertion at the serialization boundary", () => {
  it("truncates over-cap TEXT honestly and says so", async () => {
    const long = "x".repeat(ARTIFACT_CONTENT_CHANNEL_CAPS.text + 5_000);
    const projection = await buildArtifactContentProjection(
      { orgId: ORG, artifactId: ART, representationRevisionId: REV, form: "file", mime: "text/plain" },
      ports({ class: "text", text: long }),
    );
    if (projection.kind !== "text") throw new Error("expected a text projection");
    expect(projection.truncated).toBe(true);
    // The FULL length is still reported, so a display can say "showing part of".
    expect(projection.byteLength).toBe(long.length);
    expect(projection.projectedByteLength).toBeLessThanOrEqual(ARTIFACT_CONTENT_CHANNEL_CAPS.text);
    // The projection carries the cap it was built under, so the assertion at the
    // serialization boundary is pure arithmetic over the snapshot.
    expect(projection.cap).toBe(ARTIFACT_CONTENT_CHANNEL_CAPS.text);
  });

  it("never splits a code point when it truncates", () => {
    // Four-byte code points, cut one byte short of a whole one.
    const emoji = "😀".repeat(10);
    const cut = truncateToUtf8Bytes(emoji, 4 * 5 + 2);
    expect(cut).toBe("😀".repeat(5));
    expect(cut).not.toContain("�");
  });

  it("refuses to truncate a CONFIGURATION — half a configuration is not a smaller one", async () => {
    const big = { blob: "y".repeat(ARTIFACT_CONTENT_CHANNEL_CAPS.configuration + 1_000) };
    const projection = await buildArtifactContentProjection(
      { orgId: ORG, artifactId: ART, representationRevisionId: REV, form: "dashboard", mime: "application/vnd.cinatra.dashboard+json" },
      ports({ class: "configuration", configuration: big, digest: "d" }),
    );
    expect(projection).toMatchObject({ kind: "none", reason: "over-cap" });
  });

  it("THROWS at the serialization boundary for an over-cap projection the builder could not have made", () => {
    expect(() =>
      assertContentProjectionWithinCap({
        kind: "text",
        channelVersion: ARTIFACT_CONTENT_CHANNEL_VERSION,
        representationRevisionId: REV,
        text: "…",
        encoding: "utf-8",
        byteLength: 10,
        projectedByteLength: ARTIFACT_CONTENT_CHANNEL_CAPS.text + 1,
        cap: ARTIFACT_CONTENT_CHANNEL_CAPS.text,
        truncated: false,
      }),
    ).toThrow(/over its .*-byte cap/);
  });

  it("passes every projection the builder actually produces, `none` included", async () => {
    for (const input of [
      { form: "file" as const, mime: "text/markdown", substance: { class: "text" as const, text: "hello" } },
      { form: "dashboard" as const, mime: "application/vnd.cinatra.dashboard+json", substance: { class: "configuration" as const, configuration: { a: 1 }, digest: "d" } },
      { form: "connectorRef" as const, mime: "text/html", substance: { class: "page" as const, pageVersion: 1, page: {} } },
      { form: "file" as const, mime: "image/png", substance: null },
    ]) {
      const projection = await buildArtifactContentProjection(
        { orgId: ORG, artifactId: ART, representationRevisionId: REV, form: input.form, mime: input.mime },
        ports(input.substance),
      );
      expect(() => assertContentProjectionWithinCap(projection)).not.toThrow();
    }
  });
});

/**
 * THE CAP IS ONLY A CAP IF NEITHER THE CONTENT NOR THE SNAPSHOT CAN TALK IT
 * DOWN. Two ways it could be talked down, each pinned by its own case.
 */
describe("enabler 0.3 — the cap holds against the content, and against the snapshot", () => {
  it("NEVER returns more bytes than the cap, whatever the value's last character is", () => {
    // THE CASE THAT USED TO OVER-SHOOT. The old rule dropped the replacement
    // character the split produced only when the INPUT did not itself end in
    // one — so a value whose genuine last character is U+FFFD kept the split's
    // replacement character too, and the prefix came back TWO bytes over the
    // cap. `assertContentProjectionWithinCap` throws on that, so one artifact
    // with an ordinary Unicode tail broke its own card.
    const pathological = "a".repeat(7) + "\u{1F600}" + "\uFFFD";
    const cut = truncateToUtf8Bytes(pathological, 8);
    expect(Buffer.byteLength(cut, "utf8")).toBeLessThanOrEqual(8);
    expect(cut).toBe("a".repeat(7));

    // And the invariant, swept: no cap, on any of these values, may be exceeded.
    const values = [
      "a".repeat(40),
      "\u{1F600}".repeat(10),
      "n\u00e4\u00e4".repeat(10),
      "a".repeat(7) + "\u{1F600}" + "\uFFFD",
      "\uFFFD".repeat(10),
      "\u{1F600}" + "\uFFFD".repeat(5),
    ];
    for (const value of values) {
      for (let cap = 0; cap <= 24; cap += 1) {
        const out = truncateToUtf8Bytes(value, cap);
        expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(cap);
        // A prefix, never a rewrite of the work.
        expect(value.startsWith(out)).toBe(true);
      }
    }
  });

  it("keeps a GENUINE trailing replacement character when nothing was cut", () => {
    const value = "ok\uFFFD";
    expect(truncateToUtf8Bytes(value, 100)).toBe(value);
  });

  it("mirrors the SDK leaf's caps exactly — the props contract may not drift from them", () => {
    // The props contract imports nothing at value level (the route-graph
    // ratchet), so the caps are mirrored there. A mirror only holds while a test
    // pins it, exactly as the channel version's mirror is pinned above.
    expect(ARTIFACT_CONTENT_CHANNEL_CAPS_MIRROR).toEqual({
      text: ARTIFACT_CONTENT_CHANNEL_CAPS.text,
      configuration: ARTIFACT_CONTENT_CHANNEL_CAPS.configuration,
      page: ARTIFACT_CONTENT_CHANNEL_CAPS.page,
    });
  });

  it("REFUSES a projection at the serialization boundary that stamps a larger cap on itself", () => {
    // The size assertion the enabler names runs on the SNAPSHOT, in
    // `assertSerializableRendererProps`. Checking only the stamped cap would let
    // a projection buy room by stamping a bigger number — and the payload this
    // channel exists to bound would cross the boundary anyway. Both caps bind.
    const snapshot = (cap: number, projected: number) =>
      ({
        propsApiVersion: 1,
        artifact: {},
        representation: { revisionId: REV, mime: "text/markdown" },
        urls: { preview: null, download: null },
        identity: { kind: "no-primary", extension: null },
        actions: { download: null, openInSource: null },
        content: {
          kind: "text",
          channelVersion: HOST_MIRRORED_CHANNEL_VERSION,
          representationRevisionId: REV,
          text: "x",
          encoding: "utf-8",
          byteLength: projected,
          projectedByteLength: projected,
          cap,
          truncated: false,
        },
      }) as unknown as ArtifactRendererProps;

    expect(() =>
      assertSerializableRendererProps(
        snapshot(ARTIFACT_CONTENT_CHANNEL_CAPS.text * 100, ARTIFACT_CONTENT_CHANNEL_CAPS.text + 1),
      ),
    ).toThrow(/over its .*-byte cap/);

    // The honest snapshot still passes, and so does an honest truncated one.
    expect(() =>
      assertSerializableRendererProps(
        snapshot(ARTIFACT_CONTENT_CHANNEL_CAPS.text, ARTIFACT_CONTENT_CHANNEL_CAPS.text),
      ),
    ).not.toThrow();
    expect(() => assertSerializableRendererProps(snapshot(16, 8))).not.toThrow();
  });
});
