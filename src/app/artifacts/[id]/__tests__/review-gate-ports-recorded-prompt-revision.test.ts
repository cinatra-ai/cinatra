/**
 * cinatra#3080, the fix leg — THE PICTURE PROMPT BELONGS TO THE REVIEWED
 * REVISION.
 *
 * `readRecordedPromptFor` resolved the prompt by ARTIFACT ID alone and answered
 * with `recordedPrompt`, which is projected off the LIVE object row. A review
 * gate's pin is frozen while the artifact moves on — that is what Regenerate
 * does — so an older pinned review was handed the prompt the artifact records
 * NOW: the reviewer read the newest revision's instructions beside a picture
 * made from different ones, and Regenerate would have re-sent them.
 *
 * The prompt is therefore answered only for the revision the row's prompt
 * belongs to (the row's own `latestRepresentationRevisionId`); an older pin has
 * no record of its own revision's prompt and answers the same null the function
 * already gives a row that records none.
 *
 * MOCKED, not DB-gated: this proves the PORT's own reading, exactly the way the
 * sibling `review-gate-ports-repair-pair.test.ts` proves `loadPinnedRepairPair`
 * (the underlying store read has its own suite). The one mock is PARTIAL, so
 * every other member of the artifact service stays real and this file leaves the
 * module registry as it found it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/artifacts/artifact-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/artifacts/artifact-service")>();
  return { ...actual, readArtifactForDetail: vi.fn() };
});

import {
  readArtifactForDetail,
  type ArtifactSummary,
} from "@/lib/artifacts/artifact-service";
import type { PreparedReviewTarget } from "@/lib/artifacts/artifact-review-preparation";
import { readRecordedPromptFor } from "../review-gate-ports";

const readArtifact = vi.mocked(readArtifactForDetail);

const ORG = "org-3080";
const ARTIFACT = "art-picture-1";
/** The revision the review was pinned on. */
const REVIEWED_REVISION = "rev-N";
/** The revision Regenerate filed after it — what the row points at now. */
const LATEST_REVISION = "rev-N-plus-1";
const REVIEWED_PROMPT = "a red bicycle against a harbour wall";
const LATEST_PROMPT = "a blue bicycle against a harbour wall";

const actorCtx = {
  actor: { actorType: "human" as const, source: "ui" as const, userId: "user-1" },
  orgId: ORG,
  roleHints: { platformRole: "member" as const, actorOrganizationId: ORG },
};

function summary(over: Partial<ArtifactSummary> = {}): ArtifactSummary {
  return {
    artifactId: ARTIFACT,
    latestRepresentationRevisionId: LATEST_REVISION,
    objectType: "@cinatra-ai/blog-post-artifact:image",
    artifactType: "file",
    title: "The picture",
    mime: "image/png",
    size: 2048,
    originKind: "agent_generated",
    createdAt: "2026-09-01T10:00:00.000Z",
    updatedAt: "2026-09-02T10:00:00.000Z",
    ownerLevel: "organization",
    visibility: "organization",
    ownerId: null,
    organizationId: ORG,
    projectId: null,
    eligibleExtensions: [],
    primaryExtension: null,
    effectiveIdentity: { kind: "no-primary" },
    presentationIdentity: { kind: "no-primary" },
    presentationSuggestions: [],
    sourceUrl: null,
    recordedPrompt: LATEST_PROMPT,
    ...over,
  };
}

/** One pinned target, the shape the preparation hands the surface. */
function pinnedAt(representationRevisionId: string): PreparedReviewTarget[] {
  return [
    {
      target: { artifactId: ARTIFACT, representationRevisionId },
      props: null,
      mount: { kind: "floor", slot: "detail", packageName: null, reason: "no-semantic-renderer" },
    },
  ];
}

beforeEach(() => {
  readArtifact.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cinatra#3080 — the picture prompt is the REVIEWED revision's, never the artifact's current one", () => {
  it("does NOT show the newest prompt on a review pinned at an EARLIER revision", () => {
    // The row has moved on: Regenerate filed revision N+1 and recorded its own
    // prompt. The review under the reader's eyes is still pinned at N.
    readArtifact.mockReturnValue({ kind: "ok", artifact: summary() });

    const prompt = readRecordedPromptFor(pinnedAt(REVIEWED_REVISION), actorCtx);

    // The defect was `LATEST_PROMPT` here — the instructions of a revision this
    // review never saw.
    expect(prompt).not.toBe(LATEST_PROMPT);
    expect(prompt).toBeNull();
    // Read ONCE, through the same authorized projection, keyed on the pinned
    // artifact — no new read path.
    expect(readArtifact).toHaveBeenCalledTimes(1);
    expect(readArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ artifactId: ARTIFACT, orgId: ORG }),
    );
  });

  it("shows the prompt when the pin IS the revision the row's prompt belongs to", () => {
    readArtifact.mockReturnValue({
      kind: "ok",
      artifact: summary({
        latestRepresentationRevisionId: REVIEWED_REVISION,
        recordedPrompt: REVIEWED_PROMPT,
      }),
    });

    expect(readRecordedPromptFor(pinnedAt(REVIEWED_REVISION), actorCtx)).toBe(REVIEWED_PROMPT);
  });

  it("a row that records no prompt answers null, pinned at its own revision", () => {
    readArtifact.mockReturnValue({
      kind: "ok",
      artifact: summary({
        latestRepresentationRevisionId: REVIEWED_REVISION,
        recordedPrompt: null,
      }),
    });

    expect(readRecordedPromptFor(pinnedAt(REVIEWED_REVISION), actorCtx)).toBeNull();
  });

  it("KNOWN LIMIT: a re-filed latest revision is still answered with the row's ONE prompt", () => {
    // Said out loud because the check reads like provenance and is not. A
    // re-file advances `latestRepresentationRevisionId` and leaves the row's
    // recorded prompt untouched — the ledger keeps one prompt per ROW, never one
    // per revision — so a review pinned on the re-filed revision is answered
    // with the prompt the row carried BEFORE it. That is the state this head
    // can reach and cannot tell apart, unchanged by the fix above; closing it
    // needs a per-revision prompt record, which nothing here adds. Pinned so the
    // limit is visible in the suite rather than only in prose.
    readArtifact.mockReturnValue({
      kind: "ok",
      artifact: summary({
        latestRepresentationRevisionId: LATEST_REVISION,
        recordedPrompt: REVIEWED_PROMPT,
      }),
    });

    expect(readRecordedPromptFor(pinnedAt(LATEST_REVISION), actorCtx)).toBe(REVIEWED_PROMPT);
  });

  it("a reader who may not read the row gets null, and no prompt leaks through the pin check", () => {
    readArtifact.mockReturnValue({ kind: "denied" });

    expect(readRecordedPromptFor(pinnedAt(LATEST_REVISION), actorCtx)).toBeNull();
  });

  it("a multi-target gate still answers null without reading anything", () => {
    const targets = [...pinnedAt(LATEST_REVISION), ...pinnedAt(LATEST_REVISION)];

    expect(readRecordedPromptFor(targets, actorCtx)).toBeNull();
    expect(readArtifact).not.toHaveBeenCalled();
  });
});
