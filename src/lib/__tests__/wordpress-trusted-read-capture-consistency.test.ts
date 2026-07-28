import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { classifyAnnotations } from "@cinatra-ai/mcp-server/annotation-classifier";
import { isKnownDestructiveToolName } from "@cinatra-ai/mcp-server/known-destructive-floor";
import {
  TRUSTED_READ_DESCRIPTOR_SET,
  computeTrustedReadDescriptorSetHash,
} from "@/lib/connector-instance-trusted-read-descriptors";
import { computeTrustedReadFingerprint } from "@/lib/connector-instance-trusted-read-verifier";

// cinatra#2019 S4 — the descriptor⇄capture CONSISTENCY GATE (the descriptor
// supply-chain invariant): every shipped trusted-read descriptor entry must be re-derivable
// from the COMMITTED, provenance-hashed community-stack capture at the pinned
// tuple. A phantom entry (no capture backing), a pin bump without a descriptor
// review, or a stale exposure-mode assumption reds CI here — populating the
// injectable set is therefore always a reviewed code change anchored to
// committed evidence, never a drive-by edit.
//
// HOW TO RESOLVE A FAILURE IN THIS FILE (the two lawful routes):
//   1. You are POPULATING the set after a stack-pin bump whose refreshed
//      capture shows FIRST-CLASS default-server reads: add entries derived
//      from the new capture, bump `TRUSTED_READ_DESCRIPTOR_SET.version`,
//      update the version⇄hash pair below, and ship the disclosure/consent
//      re-acknowledgement ceremony with it (the consent-stamp binding).
//   2. You bumped the stack pin (captures refreshed) WITHOUT populating:
//      update `pinnedTuple` + the explicit-empty expectations together in the
//      SAME reviewed change.
// Editing an expectation here alone is never a resolution.

const CAPTURES_DIR = fileURLToPath(
  new URL("../../../tests/e2e/wp-mcp-gateway/captures/", import.meta.url),
);

function loadCapture<T = Record<string, unknown>>(name: string): T {
  return JSON.parse(readFileSync(`${CAPTURES_DIR}${name}`, "utf8")) as T;
}

type CapturedWireTool = {
  name: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
};

type CaptureTranscriptSide = {
  url?: string;
  transcripts: Array<{
    request?: { method?: string };
    status?: number;
    parsed?: { result?: { tools?: CapturedWireTool[] } };
  }>;
};

/** Extract the successful wire `tools/list` rows for one captured server.
 * THROWS when no such transcript exists — a capture-format drift must fail
 * this gate loudly, never let its per-entry loops pass vacuously. */
function extractWireToolsList(side: CaptureTranscriptSide, label: string): CapturedWireTool[] {
  for (const transcript of side.transcripts) {
    if (transcript.request?.method !== "tools/list") continue;
    if (transcript.status !== 200) continue;
    const tools = transcript.parsed?.result?.tools;
    if (Array.isArray(tools)) return tools;
  }
  throw new Error(
    `capture-consistency: no successful tools/list transcript found for ${label} — ` +
      "the committed capture format drifted; fix the extraction, do not weaken the gate",
  );
}

const exposure = loadCapture<{
  versions: { wp: string; mcpAdapter: string; eafm: string };
  mode: string;
  evidence: string;
}>("exposure-mode.json");

const rawToolsCapture = loadCapture<{
  defaultServer: CaptureTranscriptSide;
  fixtureServer: CaptureTranscriptSide;
}>("annotations-a-raw-tools-list.json");

const defaultServerTools = extractWireToolsList(rawToolsCapture.defaultServer, "defaultServer");
const fixtureServerTools = extractWireToolsList(rawToolsCapture.fixtureServer, "fixtureServer");

describe("descriptor set ⇄ committed capture consistency (cinatra#2019 S4)", () => {
  it("(a) the pinned tuple equals the capture's versions block byte-for-byte", () => {
    // A stack-pin bump refreshes the captures in the same PR (the capture-
    // freshness gate) — this assertion forces the descriptor review with it.
    expect(TRUSTED_READ_DESCRIPTOR_SET.pinnedTuple).toEqual(exposure.versions);
  });

  it("(c) while the captured default-server exposure is triad-only, the set is EMPTY", () => {
    // The S1 capture verdict for the pinned stack: the default adapter server
    // exposes ONLY the gateway triad — no per-ability wire tool exists there,
    // so no descriptor entry can carry the capture proof an entry requires.
    // If `mode` changed, you are on resolution route 1 or 2 (file header).
    expect(exposure.mode).toBe("triad-only");
    expect(TRUSTED_READ_DESCRIPTOR_SET.entries).toEqual([]);
  });

  it("(b) every entry is re-derivable from the DEFAULT server capture: first-class row + tsr1 fingerprint equality", () => {
    for (const entry of TRUSTED_READ_DESCRIPTOR_SET.entries) {
      // Entries may only exist at all under first-class default exposure.
      expect.soft(exposure.mode, `entry "${entry.name}" requires first-class exposure`).toBe(
        "first-class",
      );
      const rows = defaultServerTools.filter((tool) => tool.name === entry.name);
      expect(rows, `entry "${entry.name}" must match exactly one captured wire row`).toHaveLength(
        1,
      );
      const row = rows[0]!;
      const computed = computeTrustedReadFingerprint({
        inputSchema: row.inputSchema ?? {},
        ...(row.outputSchema !== undefined ? { outputSchema: row.outputSchema } : {}),
      });
      if (!computed.ok) {
        throw new Error(
          `entry "${entry.name}": captured schema is not fingerprintable (${computed.schema}:${computed.reason})`,
        );
      }
      expect(computed.fingerprint, `entry "${entry.name}" fingerprint`).toBe(entry.fingerprint);
      expect(computed.hasOutputSchema, `entry "${entry.name}" output-schema presence`).toBe(
        entry.hasOutputSchema,
      );
    }
  });

  it("(d) every entry's CAPTURED annotations classify read and miss the destructive floor", () => {
    for (const entry of TRUSTED_READ_DESCRIPTOR_SET.entries) {
      const row = defaultServerTools.find((tool) => tool.name === entry.name);
      expect(row, `entry "${entry.name}" captured row`).toBeDefined();
      expect(
        classifyAnnotations(row?.annotations ?? {}),
        `entry "${entry.name}" must classify read from its CAPTURED annotations`,
      ).toBe("read");
      expect(
        isKnownDestructiveToolName(entry.name),
        `entry "${entry.name}" must not hit the known-destructive floor`,
      ).toBe(false);
    }
  });

  it("(e) version⇄content hygiene: the shipped {version, canonical-entries hash} pair is pinned", () => {
    // HYGIENE, not the security edge: consent safety rests on the PERSISTED
    // per-row descriptor_set_hash exact-match (store + builder) — any content
    // change, version-bumped or not, mismatches every existing consent stamp
    // and fails CLOSED. This static pair-pin exists so an entries change
    // without a version bump (or vice versa) reds CI *before* it ships, and
    // so nobody later "simplifies" the hash binding away in favor of the
    // version integer. On a lawful population change update BOTH together.
    expect({
      version: TRUSTED_READ_DESCRIPTOR_SET.version,
      canonicalEntriesSha256: computeTrustedReadDescriptorSetHash(
        TRUSTED_READ_DESCRIPTOR_SET.entries,
      ),
    }).toEqual({
      version: 1,
      // sha256("[]") — the canonical form of the empty v1 entries list.
      canonicalEntriesSha256: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    });
  });
});

describe("capture parser sanity + real-capture fingerprint vectors", () => {
  it("reads the pinned-stack reality out of the capture: the default server lists exactly the triad", () => {
    expect(defaultServerTools.map((tool) => tool.name).sort()).toEqual([
      "mcp-adapter-discover-abilities",
      "mcp-adapter-execute-ability",
      "mcp-adapter-get-ability-info",
    ]);
  });

  it("fingerprints every captured FIRST-CLASS fixture-server row deterministically (real-data vectors)", () => {
    expect(fixtureServerTools.length).toBeGreaterThan(0);
    for (const row of fixtureServerTools) {
      const once = computeTrustedReadFingerprint({
        inputSchema: row.inputSchema ?? {},
        ...(row.outputSchema !== undefined ? { outputSchema: row.outputSchema } : {}),
      });
      const twice = computeTrustedReadFingerprint({
        inputSchema: row.inputSchema ?? {},
        ...(row.outputSchema !== undefined ? { outputSchema: row.outputSchema } : {}),
      });
      if (!once.ok || !twice.ok) {
        throw new Error(`captured fixture row "${row.name}" failed to fingerprint`);
      }
      expect(once.fingerprint).toBe(twice.fingerprint);
      expect(once.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it("classifies the captured fixture rows with the REAL classifier + floor (the S1-proven hints)", () => {
    const byName = new Map(fixtureServerTools.map((tool) => [tool.name, tool]));
    expect(classifyAnnotations(byName.get("fixturelabs-note-get")?.annotations ?? {})).toBe("read");
    // The delete fixture is destructive BOTH ways: hints and the name floor.
    expect(classifyAnnotations(byName.get("fixturelabs-note-delete")?.annotations ?? {})).toBe(
      "destructive",
    );
    expect(isKnownDestructiveToolName("fixturelabs-note-delete")).toBe(true);
    // Unannotated ⇒ write-class (the fail-closed default the verifier relies on).
    expect(
      classifyAnnotations(byName.get("fixturelabs-note-get-unannotated")?.annotations ?? {}),
    ).toBe("write");
  });
});
