import { describe, expect, it } from "vitest";

import {
  applyConnectorRefVerification,
  buildConnectorRefArtifactData,
  buildConnectorRefSnapshotArtifact,
  connectorRefDeeplink,
  connectorRefStateForOutcome,
  CONNECTOR_REF_ARTIFACT_TYPE,
  CONNECTOR_REF_SNAPSHOT_ORIGIN_KIND,
  ConnectorRefPointerError,
  ConnectorRefSnapshotContentError,
  ConnectorRefUrlError,
  EXTERNAL_POINTER_REQUIRED_PINNABLE,
  externalPointerDispositionErrors,
  isConnectorRefContextSelectable,
  parseConnectorRefPointer,
  type ConnectorRefPointer,
  type ConnectorRefProbeResult,
} from "../connector-ref";

// ---------------------------------------------------------------------------
// connectorRef external-pointer lifecycle (cinatra#1451, epic #1424 / #1448).
// Pure leaf — no DB, no server. Every acceptance-criteria bullet has a suite:
//   pointer write · state transitions · dangling-on-upstream-delete ·
//   pin rejection · snapshot-as-independent-record · open-in-provider deeplink.
// ---------------------------------------------------------------------------

const WP_POINTER: ConnectorRefPointer = {
  url: "https://blog.example.com/wp-admin/post.php?post=42&action=edit",
  connectorId: "wordpress-mcp-connector",
  externalId: "42",
  resolvedMimeType: "text/html",
  state: "linked",
  lastVerifiedAt: "2026-07-01T00:00:00.000Z",
  remoteVersion: "etag-1",
  title: "Launch announcement",
};

function probe(
  outcome: ConnectorRefProbeResult["outcome"],
  extra?: Partial<ConnectorRefProbeResult>,
): ConnectorRefProbeResult {
  return { outcome, checkedAt: "2026-07-10T12:00:00.000Z", ...extra };
}

// ---------------------------------------------------------------------------
describe("pointer write path — buildConnectorRefArtifactData", () => {
  it("builds a bare-identity pointer row starting in the linked state", () => {
    const data = buildConnectorRefArtifactData({
      url: "https://docs.example.com/d/abc",
      connectorId: "gdrive-connector",
      externalId: "abc",
      resolvedMimeType: "application/vnd.google-apps.document",
      title: "Q3 plan",
      verifiedAt: "2026-07-01T00:00:00.000Z",
      remoteVersion: "rev-9",
    });
    expect(data.artifactType).toBe(CONNECTOR_REF_ARTIFACT_TYPE);
    expect(data.originKind).toBe("external_link");
    expect(data.connectorRef.state).toBe("linked");
    expect(data.connectorRef.url).toBe("https://docs.example.com/d/abc");
    expect(data.connectorRef.connectorId).toBe("gdrive-connector");
    expect(data.connectorRef.externalId).toBe("abc");
    expect(data.connectorRef.lastVerifiedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(data.connectorRef.remoteVersion).toBe("rev-9");
    expect(data.title).toBe("Q3 plan");
  });

  it("stores NO heavy content fields on the pointer row (bare identity only)", () => {
    const data = buildConnectorRefArtifactData({
      url: "https://docs.example.com/d/abc",
      connectorId: "gdrive-connector",
      externalId: "abc",
    });
    // Only identity + light metadata keys — never a body/bytes/html field.
    expect(Object.keys(data.connectorRef).sort()).toEqual(
      ["connectorId", "externalId", "state", "url"].sort(),
    );
    expect("bodyText" in data.connectorRef).toBe(false);
    expect("bytesBase64" in data.connectorRef).toBe(false);
  });

  it("canonicalizes the url via URL parsing (not echoed raw)", () => {
    const data = buildConnectorRefArtifactData({
      url: "HTTPS://Example.COM/Doc",
      connectorId: "c",
      externalId: "1",
    });
    expect(data.connectorRef.url).toBe("https://example.com/Doc");
  });

  it("refuses to persist an unsafe / non-http(s) / relative url", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "/rel", ""]) {
      expect(() =>
        buildConnectorRefArtifactData({ url, connectorId: "c", externalId: "1" }),
      ).toThrow(ConnectorRefUrlError);
    }
  });

  it("fails closed on a structurally invalid pointer (empty connector/external id)", () => {
    // The write path must never persist a pointer the read path would reject.
    expect(() =>
      buildConnectorRefArtifactData({ url: "https://x/1", connectorId: "", externalId: "1" }),
    ).toThrow(ConnectorRefPointerError);
    expect(() =>
      buildConnectorRefArtifactData({ url: "https://x/1", connectorId: "c", externalId: "" }),
    ).toThrow(ConnectorRefPointerError);
    // A built pointer always round-trips through the read-path parser.
    const data = buildConnectorRefArtifactData({
      url: "https://x/1",
      connectorId: "c",
      externalId: "1",
      resolver: "wp-post",
    });
    expect(parseConnectorRefPointer(data.connectorRef).ok).toBe(true);
  });

  it("round-trips through the fail-closed pointer parser", () => {
    const data = buildConnectorRefArtifactData({
      url: "https://x.example.com/1",
      connectorId: "c",
      externalId: "1",
    });
    const parsed = parseConnectorRefPointer(data.connectorRef);
    expect(parsed.ok).toBe(true);
  });

  it("rejects a malformed / extra-key pointer shape (strict, fail-closed)", () => {
    expect(parseConnectorRefPointer({ url: "https://x/1" }).ok).toBe(false); // missing ids/state
    expect(
      parseConnectorRefPointer({ ...WP_POINTER, surprise: 1 }).ok,
    ).toBe(false); // strict: unknown key
    const bad = parseConnectorRefPointer({ ...WP_POINTER, state: "broken" });
    expect(bad.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("reference-state machine — outcome mapping", () => {
  it("maps present→linked, modified→stale, absent→dangling", () => {
    expect(connectorRefStateForOutcome("present")).toBe("linked");
    expect(connectorRefStateForOutcome("modified")).toBe("stale");
    expect(connectorRefStateForOutcome("absent")).toBe("dangling");
  });

  it("is path-independent — a dangling pointer re-links when upstream returns", () => {
    const dangling: ConnectorRefPointer = { ...WP_POINTER, state: "dangling" };
    const r = applyConnectorRefVerification(dangling, probe("present", { remoteVersion: "etag-2" }));
    expect(r.previousState).toBe("dangling");
    expect(r.nextState).toBe("linked");
    expect(r.stateChanged).toBe(true);
    expect(r.pointer.remoteVersion).toBe("etag-2");
  });

  it("linked→stale when upstream content drifts (modified)", () => {
    const r = applyConnectorRefVerification(WP_POINTER, probe("modified", { remoteVersion: "etag-9" }));
    expect(r.nextState).toBe("stale");
    expect(r.stateChanged).toBe(true);
    expect(r.becameDangling).toBe(false);
    expect(r.pointer.lastVerifiedAt).toBe("2026-07-10T12:00:00.000Z");
  });

  it("advances lastVerifiedAt without a state change when still present", () => {
    const r = applyConnectorRefVerification(WP_POINTER, probe("present"));
    expect(r.nextState).toBe("linked");
    expect(r.stateChanged).toBe(false); // was already linked
    expect(r.pointer.lastVerifiedAt).toBe("2026-07-10T12:00:00.000Z");
  });

  it("only sync/verification moves state — the input pointer is never mutated", () => {
    const before = structuredClone(WP_POINTER);
    applyConnectorRefVerification(WP_POINTER, probe("absent"));
    expect(WP_POINTER).toEqual(before); // immutable update
  });

  it("preserves the last-known remoteVersion across an absent probe", () => {
    const r = applyConnectorRefVerification(WP_POINTER, probe("absent"));
    // absent probe carries no version; the prior version is retained for a
    // future re-link diff.
    expect(r.pointer.remoteVersion).toBe("etag-1");
  });
});

// ---------------------------------------------------------------------------
describe("upstream delete flags dangling and NEVER tombstones", () => {
  it("linked→dangling on a simulated upstream delete, row survives", () => {
    const r = applyConnectorRefVerification(WP_POINTER, probe("absent"));
    expect(r.nextState).toBe("dangling");
    expect(r.becameDangling).toBe(true);
    // The verification result is JUST a new pointer — no delete/tombstone
    // signal exists in the surface; the object row is untouched by design.
    expect(r.pointer.url).toBe(WP_POINTER.url);
    expect(r.pointer.connectorId).toBe(WP_POINTER.connectorId);
    expect(r.pointer.externalId).toBe(WP_POINTER.externalId);
  });

  it("does not re-flag becameDangling for an already-dangling pointer", () => {
    const dangling: ConnectorRefPointer = { ...WP_POINTER, state: "dangling" };
    const r = applyConnectorRefVerification(dangling, probe("absent"));
    expect(r.nextState).toBe("dangling");
    expect(r.stateChanged).toBe(false);
    expect(r.becameDangling).toBe(false);
  });

  it("stale→dangling also flags becameDangling", () => {
    const stale: ConnectorRefPointer = { ...WP_POINTER, state: "stale" };
    const r = applyConnectorRefVerification(stale, probe("absent"));
    expect(r.becameDangling).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("pin / context policy — pointers are pinnable:false, never selectable", () => {
  it("external pointers are never context-selectable", () => {
    expect(isConnectorRefContextSelectable()).toBe(false);
    expect(EXTERNAL_POINTER_REQUIRED_PINNABLE).toBe(false);
  });

  it("accepts an external-pointer disposition that declares pinnable:false", () => {
    expect(
      externalPointerDispositionErrors({ projection: "artifact-safe", pinnable: false }),
    ).toEqual([]);
    // absent payload defers to defaults (pinnable defaults false) — valid.
    expect(externalPointerDispositionErrors(undefined)).toEqual([]);
    // projection:none forces pinnable:false in the base union — valid.
    expect(externalPointerDispositionErrors({ projection: "none" })).toEqual([]);
  });

  it("REJECTS a pointer disposition that tries to be pinnable:true", () => {
    const errs = externalPointerDispositionErrors({ projection: "raw", pinnable: true });
    expect(errs.length).toBe(1);
    expect(errs[0]).toMatch(/pinnable:false/);
    expect(errs[0]).toMatch(/snapshot record/);
  });

  it("fails closed on a disposition that violates the base claim union", () => {
    const errs = externalPointerDispositionErrors({ projection: "bogus" });
    expect(errs.length).toBeGreaterThan(0);
  });

  it("treats null as malformed (fail-closed), not as an absent payload", () => {
    // Only `undefined` (an omitted optional field) is absence; `null` is a
    // malformed value and must NOT bypass the claims union.
    expect(externalPointerDispositionErrors(null).length).toBeGreaterThan(0);
    expect(externalPointerDispositionErrors(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("snapshot / export — a NEW independent record-class artifact", () => {
  const snapshot = buildConnectorRefSnapshotArtifact({
    pointer: WP_POINTER,
    resolved: { mime: "text/html", text: "<h1>Launch</h1>", sizeBytes: 15, title: "Launch announcement" },
    capturedAt: "2026-07-10T12:00:00.000Z",
  });

  it("captures resolved content into a self-contained file-form record", () => {
    expect(snapshot.representationForm).toBe("file");
    expect(snapshot.originKind).toBe(CONNECTOR_REF_SNAPSHOT_ORIGIN_KIND);
    expect(snapshot.mime).toBe("text/html");
    expect(snapshot.bodyText).toBe("<h1>Launch</h1>");
    expect(snapshot.title).toBe("Launch announcement");
  });

  it("records provenance as CORRELATION fields only — no artifact-ID ref, no FK", () => {
    const c = snapshot.correlation;
    expect(c).toEqual({
      connectorId: "wordpress-mcp-connector",
      externalId: "42",
      sourceUrl: "https://blog.example.com/wp-admin/post.php?post=42&action=edit",
      capturedAt: "2026-07-10T12:00:00.000Z",
      capturedFromState: "linked",
      remoteVersion: "etag-1",
    });
    // Atomicity: the snapshot embeds NO reference back to the pointer artifact.
    const flat = JSON.stringify(snapshot);
    expect(flat).not.toMatch(/artifactId/i);
    expect(flat).not.toMatch(/pointerId/i);
    expect(flat).not.toMatch(/parentId/i);
  });

  it("stays fully materialized after the pointer is deleted (servable independently)", () => {
    // Simulate pointer deletion: the snapshot holds its own bytes/text and
    // only soft correlation strings — nothing to resolve, nothing to break.
    const detached = structuredClone(snapshot);
    // Even with zero access to the (now-deleted) pointer, the content is present.
    expect(detached.bodyText).toBe("<h1>Launch</h1>");
    expect(detached.correlation.externalId).toBe("42");
  });

  it("captures a snapshot from a dangling pointer too (records the state)", () => {
    // A user may snapshot a last-known-good render even after upstream deletion,
    // if the facade still has content cached; the correlation records the state.
    const fromDangling = buildConnectorRefSnapshotArtifact({
      pointer: { ...WP_POINTER, state: "dangling" },
      resolved: { mime: "text/html", text: "<h1>cached</h1>" },
      capturedAt: "2026-07-11T00:00:00.000Z",
    });
    expect(fromDangling.correlation.capturedFromState).toBe("dangling");
  });

  it("supports binary targets (base64 bytes) and title fallback to externalId", () => {
    const bin = buildConnectorRefSnapshotArtifact({
      pointer: { url: "https://x.example.com/f", connectorId: "c", externalId: "file-7", state: "linked" },
      resolved: { mime: "application/pdf", bytesBase64: "JVBERi0=", sizeBytes: 6 },
      capturedAt: "2026-07-10T12:00:00.000Z",
    });
    expect(bin.bytesBase64).toBe("JVBERi0=");
    expect(bin.bodyText).toBeUndefined();
    expect(bin.title).toBe("file-7"); // no resolved/pointer title → externalId
  });

  it("requires EXACTLY ONE materialized representation (never neither, never both)", () => {
    // Neither → not servable → rejected.
    expect(() =>
      buildConnectorRefSnapshotArtifact({
        pointer: WP_POINTER,
        resolved: { mime: "text/html" },
        capturedAt: "2026-07-10T12:00:00.000Z",
      }),
    ).toThrow(ConnectorRefSnapshotContentError);
    // Both → ambiguous single-file record → rejected.
    expect(() =>
      buildConnectorRefSnapshotArtifact({
        pointer: WP_POINTER,
        resolved: { mime: "text/html", text: "<h1>x</h1>", bytesBase64: "eA==" },
        capturedAt: "2026-07-10T12:00:00.000Z",
      }),
    ).toThrow(ConnectorRefSnapshotContentError);
  });

  it("accepts an empty-string text body as a present (materialized) representation", () => {
    const empty = buildConnectorRefSnapshotArtifact({
      pointer: WP_POINTER,
      resolved: { mime: "text/plain", text: "" },
      capturedAt: "2026-07-10T12:00:00.000Z",
    });
    expect(empty.bodyText).toBe(""); // present, not "neither"
    expect(empty.bytesBase64).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe("open-in-provider deeplink resolver", () => {
  it("returns the canonical href for a safe pointer row", () => {
    expect(connectorRefDeeplink({ connectorRef: { url: "https://docs.example.com/d/abc?tab=1" } })).toBe(
      "https://docs.example.com/d/abc?tab=1",
    );
    expect(connectorRefDeeplink({ connectorRef: { url: "HTTPS://Example.COM" } })).toBe(
      "https://example.com/",
    );
    expect(connectorRefDeeplink({ connectorRef: WP_POINTER })).toBe(WP_POINTER.url);
  });

  it("rejects non-http(s), relative, empty, and malformed urls (href injection)", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>1</script>",
      "file:///etc/passwd",
      "vbscript:msgbox",
      "blob:https://example.com/x",
      "/docs/abc",
      "example.com/x",
      "",
      "http://",
    ]) {
      expect(connectorRefDeeplink({ connectorRef: { url } })).toBeNull();
    }
  });

  it("returns null for non-pointer / malformed data shapes (blob & dashboard artifacts)", () => {
    expect(connectorRefDeeplink(undefined)).toBeNull();
    expect(connectorRefDeeplink(null)).toBeNull();
    expect(connectorRefDeeplink("https://example.com")).toBeNull();
    expect(connectorRefDeeplink({})).toBeNull();
    expect(connectorRefDeeplink({ connectorRef: null })).toBeNull();
    expect(connectorRefDeeplink({ connectorRef: {} })).toBeNull();
    expect(connectorRefDeeplink({ connectorRef: { url: 42 } })).toBeNull();
  });
});
