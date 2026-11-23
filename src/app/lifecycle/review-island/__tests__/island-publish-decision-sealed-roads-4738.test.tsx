// cinatra#4738 round 2: A WIDGET READER'S PUBLISH ROW GETS WORKING SEALED ROADS.
//
// Inside a third-party site the reader holds no Cinatra cookie, so a publish row's image, PDF or media target and its
// capture pair load only through the sealed byte and capture roads a review gate's island already gets. This file runs
// the real island page, the real publish-decision loader, the real roads and minters, and then the real serving
// routes for what the page minted. Only the stores under them are doubles (the decision, the run's revisions, the
// live widget token, the blob), plus the one core that prepares a target, which here hands each target to the byte
// minter exactly as the real core does for a file-backed revision.
//
// Pinned here:
//   - the credentialed publish island's file-backed target gets a sealed preview and download, and its capture pair
//     sealed pictures, and the byte and capture routes SERVE them;
//   - they are proven against the row's own set, never a gate's: no gate exists for the run, and a target the row
//     does not show, a decision that is no longer the newest, and a row the reader may not read all serve nothing;
//   - a gate capability sealed with the row's subject key serves nothing either.
// Red first at ffe421ea: a publish row names no sealed road, so the target keeps the session addresses. Before the
// publish row existed at all, the file does not load:
// red-first-expect: "./publish-decision-island-subject" is not exported under the conditions
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement, isValidElement, type ReactElement, type ReactNode } from "react";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lifecycle-refs";

type Target = { artifactId: string; representationRevisionId: string };
type Who = { actor: { userId?: string; orgId?: string } };

// ---- the stores under the real code ---------------------------------------------------------------------------------
const state = {
  newestDecisionId: "dec-1",
  readable: true,
  targets: [{ artifactId: "art-1", representationRevisionId: "rev-1" }] as Target[],
  madeByRun: true,
};
const ROW = { runId: "run-1", decisionId: "dec-1", input: "proposedPages" };

vi.mock("@cinatra-ai/agents/publish-decision-island-subject", () => ({
  readPublishDecisionIslandRows: async ({ runId }: { runId: string; who: Who }) =>
    state.readable && runId === ROW.runId ? { decisionId: state.newestDecisionId, inputs: ["summary", ROW.input] } : null,
  readPublishDecisionIslandSubject: async (input: { runId: string; decisionId: string; input: string; who: Who }) =>
    state.readable && input.runId === ROW.runId && input.decisionId === state.newestDecisionId && input.input === ROW.input
      ? { runId: ROW.runId, orgId: "org-1", decided: false, targets: state.targets }
      : null,
  readRevisionsMadeByRun: async () => state.madeByRun,
}));

const begun: Array<{ byteMinter?: unknown }> = [];
vi.mock("@/app/artifacts/[id]/review-target-prepare", () => ({
  // The one core, reduced to the step this file is about: a FILE-BACKED revision (an image) is handed to the byte
  // minter, and keeps the session addresses when there is none.
  beginArtifactReviewTargets: async (args: {
    input: { targets: Target[] };
    byteMinter?: (input: { artifactId: string; representationRevisionId: string; mime: string | null }) => {
      preview: string | null;
      download: string | null;
    } | null;
  }) => {
    begun.push(args);
    return {
      ok: true,
      targets: args.input.targets.map((target) => {
        const minted = args.byteMinter ? args.byteMinter({ ...target, mime: "image/png" }) : null;
        const bytes = minted
          ? { road: "island", ...minted }
          : { road: "session", preview: `/api/artifacts/${target.artifactId}/preview`, download: null };
        return { target, prepared: Promise.resolve({ target, bytes }) };
      }),
    };
  },
}));
vi.mock("@/app/artifacts/[id]/review-gate-ports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/artifacts/[id]/review-gate-ports")>()),
  loadReviewGateSurface: vi.fn(async () => ({ kind: "refused" })),
}));

const captureRow = (id: string, role: "before" | "current", target: Target) => ({
  captureArtifactId: id,
  representationRevisionId: `${id}-png`,
  data: {
    role,
    status: "captured",
    degradedReason: null,
    boundArtifactId: target.artifactId,
    boundSnapshotRevisionId: target.representationRevisionId,
    sourceOrigin: "https://cms.example",
    postId: 7,
    capturedAt: "2026-11-23T00:00:00.000Z",
    geometry: null,
    sanitization: null,
    network: null,
    captureDigest: null,
    title: "Page",
  },
});
vi.mock("@/lib/artifacts/cms-preview-capture-store", () => ({
  readPinnedPreviewCaptures: ({ boundArtifactId, boundSnapshotRevisionId }: { boundArtifactId: string; boundSnapshotRevisionId: string }) => {
    const t = { artifactId: boundArtifactId, representationRevisionId: boundSnapshotRevisionId };
    return [captureRow(`${boundArtifactId}-cap-before`, "before", t), captureRow(`${boundArtifactId}-cap-current`, "current", t)];
  },
  readPinnedPreviewCapture: (_orgId: string, id: string) => {
    const artifactId = id.replace(/-cap-(before|current)$/, "");
    const t = { artifactId, representationRevisionId: artifactId === "art-1" ? "rev-1" : "rev-x" };
    return captureRow(id, id.endsWith("before") ? "before" : "current", t);
  },
}));

const PRINCIPAL = {
  orgId: "org-1",
  userId: "u1",
  jti: "jti-1",
  siteId: "site-1",
  client: "wordpress",
  instanceId: "inst-1",
  agentSlug: "wordpress-assistant",
};
vi.mock("@/lib/lifecycle/widget-capture-principal", () => ({
  readLiveWidgetCapturePrincipal: (jti: string) => (jti === PRINCIPAL.jti ? { ...PRINCIPAL } : null),
}));
const readReviewGate = vi.fn(async () => null);
vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  readReviewGate: () => readReviewGate(),
  enforceReviewRunAccess: async () => ({ ok: state.readable }),
}));
vi.mock("@/lib/artifacts/artifact-read", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/artifacts/artifact-read")>()),
  resolveArtifactVersionForServe: (input: { artifactId: string; representationRevisionId: string }) => ({
    mime: "image/png",
    storageKey: `blob/${input.artifactId}/${input.representationRevisionId}`,
    sizeBytes: 4,
  }),
}));
vi.mock("@/lib/artifacts/local-disk-blob-store", () => ({
  createLocalDiskBlobStore: () => ({
    openByStorageKey: async ({ storageKey }: { storageKey: string }) => ({
      stream: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(storageKey));
          c.close();
        },
      }),
    }),
  }),
}));

// ---- the page's own edges --------------------------------------------------------------------------------------------
const resolveIslandCredentialReader = vi.fn();
vi.mock("@/lib/lifecycle/review-island-serving", () => ({
  resolveIslandCredentialReader: (args: unknown) => resolveIslandCredentialReader(args),
}));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: async () => null,
  signInRedirectTarget: async () => "/sign-in",
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
}));
vi.mock("@/lib/embed/frame-ancestors.server", () => ({ resolveVerifiedWidgetFrameOrigin: () => "https://cms.example" }));
vi.mock("@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-actor", () => ({
  resolveReviewActorContext: async () => null,
}));
vi.mock("@/app/agents/[vendor]/[packageName]/[instanceId]/review/[reviewTaskId]/review-target-panel", () => ({
  ReviewTargetPanel: () => createElement("div", null, "panel"),
}));
vi.mock("@cinatra-ai/agents/review-gate-states", () => ({
  ReviewGateLoading: () => createElement("div", null, "island-panel-loading"),
}));

import { encodePublishDecisionIslandRef, publishDecisionIslandSubjectKey } from "@/lib/lifecycle/lifecycle-card-ref";
import { mintReviewIslandByteCapability, reviewIslandByteUrl } from "@/lib/lifecycle/review-island-byte-capability";
import ReviewTargetIslandPage from "../page";
import { GET as getBytes } from "@/app/api/lifecycle-views/artifact-bytes/route";
import { GET as getCapture } from "@/app/api/lifecycle-views/capture/route";

const ACTOR = {
  actor: { actorType: "human", userId: "u1", orgId: "org-1", source: "route" },
  orgId: "org-1",
  roleHints: { actorOrganizationId: "org-1" },
};

function streams(node: ReactNode): Array<{ prepared: Promise<{ bytes: Record<string, unknown> }>; capturePair: Promise<unknown> }> {
  if (Array.isArray(node)) return node.flatMap(streams);
  if (!isValidElement(node)) return [];
  const props = node.props as { prepared?: unknown; capturePair?: unknown; children?: ReactNode };
  if (props.prepared && props.capturePair) return [props as never];
  return streams(props.children);
}

async function paint(): Promise<{ bytes: Record<string, unknown>; pair: { left: { imageUrl: string | null } | null; right: { imageUrl: string | null } | null } | null }> {
  const ref = encodePublishDecisionIslandRef(ROW)!;
  const el = (await ReviewTargetIslandPage({ searchParams: Promise.resolve({ ref, ic: "sealed-credential" }) })) as ReactElement;
  const [one] = streams(el);
  expect(one, "the island drew no target").toBeDefined();
  return { bytes: (await one.prepared).bytes, pair: (await one.capturePair) as never };
}

const fetchHeaders = (dest: string) =>
  new Headers({ "sec-fetch-dest": dest, "sec-fetch-site": "same-origin", "sec-fetch-mode": "no-cors" });
const serveBytes = (url: string) => getBytes(new Request(`http://localhost:3000${url}`, { headers: fetchHeaders("image") }));
const serveCapture = (url: string) => getCapture(new Request(`http://localhost:3000${url}`, { headers: fetchHeaders("image") }));

beforeEach(() => {
  begun.length = 0;
  state.newestDecisionId = "dec-1";
  state.readable = true;
  state.targets = [{ artifactId: "art-1", representationRevisionId: "rev-1" }];
  state.madeByRun = true;
  readReviewGate.mockClear();
  resolveIslandCredentialReader.mockResolvedValue({
    actorCtx: ACTOR,
    runId: ROW.runId,
    reviewTaskId: publishDecisionIslandSubjectKey(ROW),
    publishDecision: { decisionId: ROW.decisionId, input: ROW.input },
    principal: PRINCIPAL,
  });
});

describe("a credentialed publish-decision island", () => {
  it("hands its file-backed target sealed byte addresses, and the byte route serves them", async () => {
    const { bytes } = await paint();
    expect(typeof begun[0]?.byteMinter).toBe("function");
    expect(bytes.road).toBe("island");
    expect(bytes.preview).toMatch(/^\/api\/lifecycle-views\/artifact-bytes\?bc=/);
    expect(bytes.download).toMatch(/^\/api\/lifecycle-views\/artifact-bytes\?bc=/);
    const preview = await serveBytes(bytes.preview as string);
    expect(preview.status).toBe(200);
    expect(await preview.text()).toBe("blob/art-1/rev-1");
    expect((await serveBytes(bytes.download as string)).status).toBe(200);
    // Proven against the row, never a gate: the run has no gate, and the gate store was never asked.
    expect(readReviewGate).not.toHaveBeenCalled();
  });

  it("hands its capture pair sealed pictures, and the capture route serves them", async () => {
    const { pair } = await paint();
    expect(pair?.left?.imageUrl).toMatch(/^\/api\/lifecycle-views\/capture\?c=/);
    expect(pair?.right?.imageUrl).toMatch(/^\/api\/lifecycle-views\/capture\?c=/);
    const left = await serveCapture(pair!.left!.imageUrl!);
    expect(left.status).toBe(200);
    expect(await left.text()).toBe("blob/art-1-cap-before/art-1-cap-before-png");
    expect((await serveCapture(pair!.right!.imageUrl!)).status).toBe(200);
    expect(readReviewGate).not.toHaveBeenCalled();
  });

  it("serves nothing once the decision is no longer the newest, or the reader may no longer read the run", async () => {
    const { bytes, pair } = await paint();
    expect((await serveBytes(bytes.preview as string)).status).toBe(200);
    expect((await serveCapture(pair!.left!.imageUrl!)).status).toBe(200);
    state.newestDecisionId = "dec-2";
    expect((await serveBytes(bytes.preview as string)).status).toBe(404);
    expect((await serveCapture(pair!.left!.imageUrl!)).status).toBe(404);
    state.newestDecisionId = "dec-1";
    state.readable = false;
    expect((await serveBytes(bytes.preview as string)).status).toBe(404);
    expect((await serveCapture(pair!.left!.imageUrl!)).status).toBe(404);
  });

  it("serves nothing once the row no longer shows the target, or the run did not make it", async () => {
    const { bytes } = await paint();
    expect((await serveBytes(bytes.preview as string)).status).toBe(200);
    state.targets = [{ artifactId: "art-2", representationRevisionId: "rev-2" }];
    expect((await serveBytes(bytes.preview as string)).status).toBe(404);
    state.targets = [{ artifactId: "art-1", representationRevisionId: "rev-1" }];
    state.madeByRun = false;
    expect((await serveBytes(bytes.preview as string)).status).toBe(404);
  });

  it("a GATE capability sealed with the row's subject key serves nothing: the kinds never cross", async () => {
    const sealed = mintReviewIslandByteCapability({
      ...PRINCIPAL,
      runId: ROW.runId,
      reviewTaskId: publishDecisionIslandSubjectKey(ROW),
      artifactId: "art-1",
      representationRevisionId: "rev-1",
      disposition: "preview",
    })!;
    expect((await serveBytes(reviewIslandByteUrl(sealed))).status).toBe(404);
    expect(readReviewGate).toHaveBeenCalled();
  });
});
