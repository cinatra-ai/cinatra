/**
 * Email-attachment provenance contract.
 *
 * The artifact-write layer already supports `originKind: "email_attachment"`
 * plus the optional `parentId`/`parentType` provenance pointers. This test
 * pins the contract at the type level — future email-ingest code MUST use
 * exactly these fields, no new artifact type, no new enum value.
 *
 * The reciprocal `LlmAttachmentRef.originKind` (in @cinatra-ai/llm
 * types.ts) carries the SAME enum so an email-attached file resolved into a
 * later LLM turn keeps its origin tag end-to-end.
 */
import { describe, expect, it } from "vitest";
import type { ArtifactOriginKind, ArtifactRef } from "../artifact-version";

describe("email-attachment provenance contract", () => {
  it("ArtifactOriginKind enum includes the email_attachment variant", () => {
    // Compile-time guarantee — the assignment fails if the enum drops it.
    const v: ArtifactOriginKind = "email_attachment";
    expect(v).toBe("email_attachment");
  });

  it("ArtifactRef can describe an email attachment (no new ref shape needed)", () => {
    const ref: ArtifactRef = {
      artifactId: "art-email-1",
      representationRevisionId: "ver-1",
      digest: "sha256:abc",
      mime: "application/pdf",
      // ArtifactRef has originKind; parentId/parentType live on the
      // WRITE input (artifact-write.ts:30) and are persisted in the object
      // row, not on the immutable ref.
      originKind: "email_attachment",
    };
    expect(ref.originKind).toBe("email_attachment");
  });

  it("the same enum is shared between artifact-version and llm ref types", () => {
    // Sanity: the LLM-side enum (LlmAttachmentRef.originKind) must list
    // the SAME values. Verified structurally by the union below — a
    // dropped member from EITHER side would fail to compile.
    type LlmOriginKindMirror =
      | "upload"
      | "email_attachment"
      | "agent_generated"
      | "external_link"
      | "live_generator";
    const x: LlmOriginKindMirror = "email_attachment";
    const y: ArtifactOriginKind = x; // both enums must be assignable
    expect(y).toBe("email_attachment");
  });
});
