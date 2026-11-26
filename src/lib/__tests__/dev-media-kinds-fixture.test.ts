import { inflateSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// cinatra#3459: the widget's review island draws media only through the byte
// road, and no fixture filed the six kinds it serves. These cases require one.

const mock = vi.hoisted(() => {
  process.env.BETTER_AUTH_SECRET ??= "dev-media-kinds-placeholder-not-a-credential";
  return { resolve: vi.fn(), upload: vi.fn(), register: vi.fn(), member: vi.fn(), userContext: vi.fn() };
});
vi.mock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: mock.register }));
vi.mock("@/lib/artifacts/upload-artifact-type-map", () => ({ resolveUploadArtifactType: mock.resolve }));
vi.mock("@/lib/artifacts/artifact-service", () => ({ createUploadedArtifact: mock.upload }));
vi.mock("@/lib/better-auth-db", () => ({ readUserIsOrgMember: mock.member }));
vi.mock("@/lib/auth-session", () => ({ resolveUserContextForUserId: mock.userContext, isPlatformAdmin: () => false }));

import { readFileSync } from "node:fs";
import path from "node:path";
import { MEDIA_BYTE_ROAD_KINDS, mediaByteRoadKindFor } from "@/lib/lifecycle/review-island-byte-road";
import { sniffMime } from "@/lib/artifacts/local-disk-blob-store";
import { crc32, mediaKindSamples } from "../../../scripts/fixtures/lib/media-kind-samples";
import {
  fileMediaKindSamples, parsePromoteOption, promoteFiledUpload, seedMediaKindReviewRun,
} from "../../../scripts/fixtures/lib/file-media-kinds";

const sample = (kind: string) => {
  const found = mediaKindSamples().find((s) => s.kind === kind);
  if (!found) throw new Error(`no ${kind} sample`);
  return found.bytes;
};

/** The entries of a ZIP, read from its central directory, CRC-checked. */
function zipEntries(bytes: Buffer) {
  // The end record carries no comment, so it closes the file, and the central
  // directory ends where the end record starts.
  const end = bytes.length - 22;
  expect(bytes.readUInt32LE(end)).toBe(0x06054b50);
  expect(bytes.readUInt16LE(end + 20)).toBe(0);
  const count = bytes.readUInt16LE(end + 10);
  expect(bytes.readUInt16LE(end + 8)).toBe(count);
  let at = bytes.readUInt32LE(end + 16);
  expect(at + bytes.readUInt32LE(end + 12)).toBe(end);
  const entries = new Map<string, Buffer>();
  for (let i = 0; i < count; i += 1) {
    expect(bytes.readUInt32LE(at)).toBe(0x02014b50);
    const method = bytes.readUInt16LE(at + 10), crc = bytes.readUInt32LE(at + 16), size = bytes.readUInt32LE(at + 24);
    expect(method, "stored entries only").toBe(0);
    expect(bytes.readUInt32LE(at + 20), "stored size").toBe(size);
    const nameLength = bytes.readUInt16LE(at + 28), extra = bytes.readUInt16LE(at + 30), comment = bytes.readUInt16LE(at + 32);
    const local = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    expect(bytes.readUInt32LE(local)).toBe(0x04034b50);
    // The local header agrees with the central entry: method, CRC, sizes and name.
    expect(bytes.readUInt16LE(local + 8), `${name} local method`).toBe(method);
    expect(bytes.readUInt32LE(local + 14), `${name} local CRC`).toBe(crc);
    expect(bytes.readUInt32LE(local + 18), `${name} local size`).toBe(size);
    expect(bytes.readUInt32LE(local + 22), `${name} local size`).toBe(size);
    expect(bytes.subarray(local + 30, local + 30 + bytes.readUInt16LE(local + 26)).toString("utf8")).toBe(name);
    const dataAt = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    const data = bytes.subarray(dataAt, dataAt + size);
    expect(crc32(data), `${name} CRC`).toBe(crc);
    entries.set(name, data);
    at += 46 + nameLength + extra + comment;
  }
  return entries;
}

describe("development media kind samples (#3459)", () => {
  it("cover exactly the six kinds of the byte road, each under a form of its own kind", () => {
    const samples = mediaKindSamples();
    expect(samples.map((s) => s.kind).sort()).toEqual(Object.keys(MEDIA_BYTE_ROAD_KINDS).sort());
    for (const s of samples) expect(mediaByteRoadKindFor(s.mime), s.kind).toBe(s.kind);
  });

  it("are detected by the blob store as the form they are filed under", () => {
    for (const s of mediaKindSamples()) expect(sniffMime(s.bytes.subarray(0, 512), s.mime), s.kind).toBe(s.mime);
  });

  it("are the same bytes on every call", () => {
    const [a, b] = [mediaKindSamples(), mediaKindSamples()];
    for (let i = 0; i < a.length; i += 1) expect(a[i].bytes.equals(b[i].bytes), a[i].kind).toBe(true);
  });

  it("make a PNG whose chunks check and whose pixels inflate to its size", () => {
    const png = sample("image");
    let at = 8;
    const chunks = new Map<string, Buffer>();
    while (at < png.length) {
      const length = png.readUInt32BE(at);
      const typed = png.subarray(at + 4, at + 8 + length);
      expect(crc32(typed)).toBe(png.readUInt32BE(at + 8 + length));
      chunks.set(typed.subarray(0, 4).toString("latin1"), typed.subarray(4));
      at += 12 + length;
    }
    const ihdr = chunks.get("IHDR")!;
    const [width, height] = [ihdr.readUInt32BE(0), ihdr.readUInt32BE(4)];
    expect(inflateSync(chunks.get("IDAT")!).length).toBe(height * (1 + width * 3));
    expect(chunks.has("IEND")).toBe(true);
  });

  it("make a WebM video, a PCM WAV and a PDF whose cross references point at their objects", () => {
    const webm = sample("video");
    expect(webm.subarray(0, 4).toString("hex")).toBe("1a45dfa3");
    expect(webm.includes(Buffer.from("webm"))).toBe(true);
    expect(webm.includes(Buffer.from("V_VP8"))).toBe(true);

    const wav = sample("audio");
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav.subarray(36, 40).toString("latin1")).toBe("data");
    expect(wav.readUInt32LE(40)).toBe(wav.length - 44);

    const pdf = sample("pdf").toString("latin1");
    const startxref = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(pdf)?.[1]);
    expect(pdf.slice(startxref, startxref + 4)).toBe("xref");
    const offsets = [...pdf.slice(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(5);
    offsets.forEach((offset, i) => expect(pdf.slice(offset).startsWith(`${i + 1} 0 obj`)).toBe(true));
  });

  it("make a Word document and an archive whose entries check", () => {
    const docx = zipEntries(sample("document"));
    expect([...docx.keys()]).toEqual(["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);
    expect(docx.get("word/document.xml")!.toString("utf8")).toContain("<w:t>");
    expect([...zipEntries(sample("archive")).keys()]).toEqual(["README.txt", "data/sample.csv"]);
  });
});

describe("development media kind filing (#3459)", () => {
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("CINATRA_RUNTIME_MODE", "development");
    mock.member.mockResolvedValue(true);
    mock.resolve.mockImplementation((mime: string) => ({ ok: true, objectTypeId: `type-for:${mime}` }));
    let n = 0;
    mock.upload.mockImplementation(async () => { n += 1; return { artifactId: `artifact-${n}`, representationRevisionId: `revision-${n}` }; });
  });

  it("files each kind's exact bytes as the user's private upload and returns the six review targets", async () => {
    const filed = await fileMediaKindSamples({ orgId: "org", userId: "user" });
    const samples = mediaKindSamples();
    expect(filed.map((f) => f.kind)).toEqual(samples.map((s) => s.kind));
    expect(mock.upload).toHaveBeenCalledTimes(6);
    for (const [i, s] of samples.entries()) {
      const input = mock.upload.mock.calls[i][0];
      expect(input).toMatchObject({
        orgId: "org", createdBy: "user", ownerLevel: "user", ownerId: "user", visibility: "private",
        declaredMime: s.mime, originKind: "upload", skipFallbackClassification: true,
      });
      const chunks: Uint8Array[] = [];
      for await (const bytes of input.stream) chunks.push(bytes);
      expect(Buffer.concat(chunks).equals(s.bytes), s.kind).toBe(true);
      expect(filed[i]).toEqual({
        kind: s.kind, mime: s.mime, objectType: `type-for:${s.mime}`,
        artifactId: `artifact-${i + 1}`, representationRevisionId: `revision-${i + 1}`,
      });
    }
  });

  it("files nothing when any kind has no installed upload type", async () => {
    mock.resolve.mockImplementation((mime: string) => mime === "audio/wav"
      ? { ok: false, kind: "no_type", reason: "no required type accepts audio/wav", matched: [] }
      : { ok: true, objectTypeId: `type-for:${mime}` });
    await expect(fileMediaKindSamples({ orgId: "org", userId: "user" })).rejects.toThrow(/audio sample.*nothing was filed/);
    expect(mock.upload).not.toHaveBeenCalled();
  });

  it("uses the trimmed ids for the membership read and every write", async () => {
    await fileMediaKindSamples({ orgId: " org ", userId: "\tuser " });
    expect(mock.member).toHaveBeenCalledWith("user", "org");
    for (const [input] of mock.upload.mock.calls) {
      expect(input).toMatchObject({ orgId: "org", createdBy: "user", ownerId: "user" });
    }
  });

  it("files nothing for a user who is not a member of the organization", async () => {
    mock.member.mockResolvedValue(false);
    await expect(fileMediaKindSamples({ orgId: "org", userId: "user" })).rejects.toThrow(/not a member of the organization.*nothing was filed/);
    expect(mock.resolve).not.toHaveBeenCalled();
    expect(mock.upload).not.toHaveBeenCalled();
  });

  it("files nothing for an empty organization or user", async () => {
    await expect(fileMediaKindSamples({ orgId: "  ", userId: "user" })).rejects.toThrow(/nonempty/);
    await expect(fileMediaKindSamples({ orgId: "org", userId: "" })).rejects.toThrow(/nonempty/);
    expect(mock.member).not.toHaveBeenCalled();
    expect(mock.upload).not.toHaveBeenCalled();
  });

  it("refuses outside the development runtime before any write", async () => {
    vi.stubEnv("CINATRA_RUNTIME_MODE", "production");
    await expect(fileMediaKindSamples({ orgId: "org", userId: "user" })).rejects.toThrow(/CINATRA_RUNTIME_MODE=development/);
    expect(mock.resolve).not.toHaveBeenCalled();
    expect(mock.upload).not.toHaveBeenCalled();
  });
});

describe("development media kind review run (#3459)", () => {
  const filed = ["image", "video", "audio", "pdf", "document", "archive"].map((kind, i) => ({
    kind, mime: `form-${i}`, objectType: `type-${i}`, artifactId: `artifact-${i}`, representationRevisionId: `revision-${i}`,
  })) as Parameters<typeof seedMediaKindReviewRun>[0]["filed"];
  const targets = filed.map(({ artifactId, representationRevisionId }) => ({ artifactId, representationRevisionId }));
  const foreign = { artifactId: "artifact-x", representationRevisionId: "revision-x" };

  // The executor mints a declared review as an atomic family of single-target
  // gates, one per artifact (packages/agents/src/artifact-review-gate-store.ts
  // emitDeclaredReviewGateFamily): legs "task", "task#2" ... "task#6". This
  // harness serves the run's gate rows as the table holds them; a `LIMIT 1`
  // read gets only the first of them.
  const gateRows = (rows: { reviewTaskId: string; status: string; pinnedTargets: typeof targets }[]) => ({
    seedMarkedReviewGateRun: vi.fn(async () => "run"),
    waitForMarkedReviewGate: vi.fn(async () => ({ gateId: "gate-1", runId: "run", ...rows[0] })),
    waitForMarkedReviewGates: vi.fn(async () => rows.map((row, i) => ({ gateId: `gate-${i + 1}`, runId: "run", ...row }))),
  });
  const family = (pins: typeof targets, base = "task") =>
    pins.map((target, i) => ({ reviewTaskId: i === 0 ? base : `${base}#${i + 1}`, status: "pending", pinnedTargets: [target] }));

  it("accepts the executor's family of six single-target gates that together pin exactly the six (#3459)", async () => {
    const h = gateRows(family(targets));
    await expect(seedMediaKindReviewRun({ orgId: "org", userId: "user", filed }, h))
      .resolves.toEqual({ runId: "run", reviewTaskId: "task", status: "pending", pinned: 6 });
  });

  it("seeds the run with the trimmed ids and the six targets, and reads every gate of the run in any order", async () => {
    const h = gateRows(family([...targets].reverse()).reverse());
    await expect(seedMediaKindReviewRun({ orgId: " org ", userId: " user ", filed }, h))
      .resolves.toEqual({ runId: "run", reviewTaskId: "task", status: "pending", pinned: 6 });
    expect(h.seedMarkedReviewGateRun).toHaveBeenCalledWith({ orgId: "org", userId: "user", targets });
    expect(h.waitForMarkedReviewGates).toHaveBeenCalledWith("run");
    expect(h.waitForMarkedReviewGate).not.toHaveBeenCalled();
  });

  it("fails when the family misses a target, pins a foreign one or pins one twice", async () => {
    for (const pins of [targets.slice(1), [...targets.slice(1), foreign], [...targets.slice(1), targets[1]], [...targets, foreign]]) {
      await expect(seedMediaKindReviewRun({ orgId: "org", userId: "user", filed }, gateRows(family(pins))))
        .rejects.toThrow(/not six single-target gates|do not pin exactly the six filed revisions/);
    }
    await expect(seedMediaKindReviewRun({ orgId: "org", userId: "user", filed }, gateRows(family([...targets.slice(1), foreign]))))
      .rejects.toThrow(/do not pin exactly the six filed revisions/);
    await expect(seedMediaKindReviewRun({ orgId: "org", userId: "user", filed }, gateRows(family([...targets.slice(1), targets[1]]))))
      .rejects.toThrow(/do not pin exactly the six filed revisions/);
  });

  it("refuses one gate that pins all six: the executor mints no new gate with several targets", async () => {
    const h = gateRows([{ reviewTaskId: "task", status: "pending", pinnedTargets: targets }]);
    await expect(seedMediaKindReviewRun({ orgId: "org", userId: "user", filed }, h))
      .rejects.toThrow(/not six single-target gates \(1 gates, 6 pins\)/);
  });

  it("refuses six single-target gates that are not one review family", async () => {
    const split = [...family(targets.slice(0, 3)), ...family(targets.slice(3), "other")];
    await expect(seedMediaKindReviewRun({ orgId: "org", userId: "user", filed }, gateRows(split)))
      .rejects.toThrow(/not one review family/);
    const noBase = family(targets).map((row, i) => ({ ...row, reviewTaskId: `task#${i + 2}` }));
    await expect(seedMediaKindReviewRun({ orgId: "org", userId: "user", filed }, gateRows(noBase)))
      .rejects.toThrow(/not one review family/);
  });

  it("refuses to seed for anything but the six filed kinds", async () => {
    const h = gateRows(family(targets));
    await expect(seedMediaKindReviewRun({ orgId: "org", userId: "user", filed: filed.slice(1) }, h)).rejects.toThrow(/six filed/);
    expect(h.seedMarkedReviewGateRun).not.toHaveBeenCalled();
  });
});

// cinatra#3459 (PR #4786): a slide deck's review card existed only after a
// person promoted a PDF upload in the type picker, so a capture that cannot
// click had no deck card to grade. The fixture confirms the picker's own
// server action for the filed upload, as the person's Confirm does.
describe("development upload promotion through the type picker (#3459)", () => {
  const DECK = "@cinatra-ai/slide-deck-artifact";
  const filed = ["image", "video", "audio", "pdf", "document", "archive"].map((kind, i) => ({
    kind, mime: `form-${i}`, objectType: `type-${i}`, artifactId: `artifact-${i}`, representationRevisionId: `revision-${i}`,
  })) as Parameters<typeof promoteFiledUpload>[0]["filed"];
  const promoted = { promoted: true as const, toType: `${DECK}:deck`, representationRevisionId: "revision-p", revision: 2 };
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(() => vi.stubEnv("CINATRA_RUNTIME_MODE", "development"));

  /** The picker's action, run only inside the fixture user's session. */
  const picker = (answer: unknown) => {
    let inside: { orgId: string; userId: string } | null = null;
    const runAs = vi.fn(async (ids: { orgId: string; userId: string }, fn: () => Promise<unknown>) => {
      inside = ids;
      try { return await fn(); } finally { inside = null; }
    });
    const confirm = vi.fn(async () => {
      if (!inside) throw new Error("the picker's action ran outside the user's session");
      return answer;
    });
    return { runAs, confirm } as unknown as NonNullable<Parameters<typeof promoteFiledUpload>[1]> & {
      runAs: typeof runAs; confirm: typeof confirm;
    };
  };

  // red-first-expect: parsePromoteOption is not a function
  it("reads --promote as one filed kind and the extension the person would confirm", () => {
    expect(parsePromoteOption(`pdf=${DECK}`)).toEqual({ kind: "pdf", extension: DECK });
    expect(parsePromoteOption(` image = @cinatra-ai/screenshot-artifact `)).toEqual({ kind: "image", extension: "@cinatra-ai/screenshot-artifact" });
    for (const bad of ["pdf", `=${DECK}`, "pdf=", "pdf= ", `movie=${DECK}`, `pdf=${DECK}=x`]) {
      expect(() => parsePromoteOption(bad), bad).toThrow(/--promote/);
    }
  });

  // red-first-expect: promoteFiledUpload is not a function
  it("confirms the filed upload's meaning through the picker's action, in the user's session, and returns the deck", async () => {
    const deps = picker({ ok: true, promotion: promoted });
    await expect(promoteFiledUpload({ orgId: " org ", userId: " user ", filed, kind: "pdf", extension: DECK }, deps))
      .resolves.toEqual({
        kind: "pdf", artifactId: "artifact-3", extension: DECK, toType: `${DECK}:deck`,
        representationRevisionId: "revision-p", revision: 2,
      });
    expect(deps.runAs).toHaveBeenCalledTimes(1);
    expect(deps.runAs.mock.calls[0][0]).toEqual({ orgId: "org", userId: "user" });
    expect(deps.confirm).toHaveBeenCalledWith({ artifactId: "artifact-3", extension: DECK });
  });

  // red-first-expect: promoteFiledUpload is not a function
  it("fails when the picker refuses, retypes nothing, or reports a promotion that did not happen", async () => {
    const input = { orgId: "org", userId: "user", filed, kind: "pdf" as const, extension: DECK };
    await expect(promoteFiledUpload(input, picker({ ok: false, reason: "invalid-type", message: "Not a choice." })))
      .rejects.toThrow(/picker refused.*invalid-type.*Not a choice/);
    await expect(promoteFiledUpload(input, picker({ ok: true })))
      .rejects.toThrow(/retyped nothing/);
    await expect(promoteFiledUpload(input, picker({ ok: true, promotion: { promoted: false, reason: "promotion-unavailable" } })))
      .rejects.toThrow(/not promoted: promotion-unavailable/);
  });

  // red-first-expect: promoteFiledUpload is not a function
  it("confirms nothing for a kind that was not filed, or outside the development runtime", async () => {
    const deps = picker({ ok: true, promotion: promoted });
    await expect(promoteFiledUpload({ orgId: "org", userId: "user", filed: filed.filter((f) => f.kind !== "pdf"), kind: "pdf", extension: DECK }, deps))
      .rejects.toThrow(/no filed pdf upload/);
    vi.stubEnv("CINATRA_RUNTIME_MODE", "production");
    await expect(promoteFiledUpload({ orgId: "org", userId: "user", filed, kind: "pdf", extension: DECK }, deps))
      .rejects.toThrow(/CINATRA_RUNTIME_MODE=development/);
    expect(deps.runAs).not.toHaveBeenCalled();
    expect(deps.confirm).not.toHaveBeenCalled();
  });
});

describe("the picker action's session in the fixture process (#3459)", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mock.userContext.mockImplementation(async (userId: string, opts?: { activeOrganizationId?: string | null }) => ({
      actorContext: { principalId: `principal:${userId}`, orgId: opts?.activeOrganizationId },
      platformRole: "member",
      sessionOrgId: opts?.activeOrganizationId ?? null,
    }));
  });

  // red-first-expect: Cannot find module '/scripts/fixtures/lib/picker-session'
  it("answers the action's session reads only inside the fixture user's run, from the product's session-free road", async () => {
    const s = await import("../../../scripts/fixtures/lib/picker-session");
    await expect(s.getAuthSession()).rejects.toThrow(/outside the fixture's picker session/);
    await expect(s.getActorContext()).rejects.toThrow(/outside the fixture's picker session/);
    const seen = await s.runAsPickerUser({ orgId: "org", userId: "user" }, async () => [await s.getAuthSession(), await s.getActorContext()]);
    expect(seen).toEqual([
      { user: { id: "user", role: null }, session: { activeOrganizationId: "org" } },
      { principalId: "principal:user", orgId: "org" },
    ]);
    expect(mock.userContext).toHaveBeenCalledWith("user", { activeOrganizationId: "org" });
    await expect(s.getAuthSession()).rejects.toThrow(/outside the fixture's picker session/);
  });

  // red-first-expect: Cannot find module '/scripts/fixtures/lib/picker-session'
  it("refuses a resolved context for another organization", async () => {
    mock.userContext.mockResolvedValue({ actorContext: {}, platformRole: "member", sessionOrgId: "other" });
    const s = await import("../../../scripts/fixtures/lib/picker-session");
    await expect(s.runAsPickerUser({ orgId: "org", userId: "user" }, async () => 1)).rejects.toThrow(/not the organization org/);
  });

  // red-first-expect: Cannot find module '/scripts/fixtures/lib/picker-action-session.mjs'
  it("swaps the session and cache modules for the picker's action only", async () => {
    const { pickerActionSessionPlugin } = await import("../../../scripts/fixtures/lib/picker-action-session.mjs");
    const root = path.resolve(__dirname, "../../../");
    const plugin = pickerActionSessionPlugin(root);
    const action = path.join(root, "src/app/artifacts/upload-typing-actions.ts");
    const source = readFileSync(action, "utf8");
    expect(plugin.enforce).toBe("pre");
    for (const id of [action, `${action}?v=1`]) {
      const out = plugin.transform(source, id)!.code;
      expect(out).toContain(`from "/scripts/fixtures/lib/picker-session.ts"`);
      expect(out).toContain(`from "/scripts/fixtures/lib/picker-cache.ts"`);
      expect(out).not.toMatch(/from\s*["'](?:@\/lib\/auth-session|next\/cache)["']/);
      expect(out).toContain(`from "@/lib/artifacts/artifact-service"`);
    }
    for (const other of ["src/app/artifacts/promotion-actions.ts", "src/lib/artifacts/artifact-service.ts"]) {
      expect(plugin.transform(`import { revalidatePath } from "next/cache";`, path.join(root, other))).toBeUndefined();
    }
    expect(() => plugin.transform(source.replace(/from "next\/cache"/, `from "next/navigation"`), action))
      .toThrow(/no longer imports next\/cache/);
  });
});
