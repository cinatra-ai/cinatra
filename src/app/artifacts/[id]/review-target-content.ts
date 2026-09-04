// THE REVIEW TARGET'S CONTENT ROAD, IN ITS OWN MODULE (cinatra#3029, epic #3023
// W5; the seam taken in for #3150).
//
// WHY IT IS NOT IN THE BINDER. `review-target-prepare.ts` is reached statically
// by four LOCKED routes (`/api/mcp`, `/chat`, `/api/a2a`, `/api/llm-bridge`)
// through the review surface's own server action, and none of them ever runs a
// preparation. One value import of the channel from there therefore charged all
// four graphs three reachable first-party modules — the channel, its contract
// package module and the digest module behind it — for a call they never make.
// The analyzer counts a dynamic `import("x")` exactly like a static one, so
// laziness buys nothing here; only the module boundary does.
//
// So the binder takes the road as a PORT, exactly the discipline its own header
// already states for the run/gate ports, and the road lives here, next to the
// two surfaces that draw it. `review-target-content-narrowness.test.ts` pins
// both halves: the binder stays clear of the channel, and every drawing surface
// supplies the port, so no surface can silently fall back to the floor.

import {
  resolveArtifactVersionForServe,
} from "@/lib/artifacts/artifact-read";
import type { RevisionMemberOutcome } from "@/lib/artifacts/artifact-review-preparation";

import {
  artifactContentCapFor,
  buildArtifactContentProjection,
  type ArtifactContentChannelPorts,
  type ArtifactRepresentationForm,
} from "@/lib/artifacts/artifact-content-channel";
import { createLocalDiskBlobStore } from "@/lib/artifacts/local-disk-blob-store";
import type { ArtifactContentProjection } from "@cinatra-ai/sdk-extensions/artifact-content-channel";

// ---------------------------------------------------------------------------
// THE CONTENT CHANNEL, WIRED FOR THE REVIEW TARGET (cinatra#3080, fix leg 7).
//
// THE DEFECT. This consumer passed `absentArtifactContent(...)` unconditionally
// and said so in a comment — "this consumer is not wired to it yet". The
// eighth proof round measured what that means on a real review: a run produced a
// `text/markdown` post, the gate pinned its revision, and the markdown display
// drew its `content-absent` floor — "No markdown is available to show for the
// revision being viewed." — over a document that was sitting readable in the
// blob store. §V of the ratified review drawing keeps the floor for the target
// that does NOT resolve; a floor over a resolvable one tells the reviewer
// something false about the work they are deciding on.
//
// WHAT IS WIRED, AND WHAT IS NOT. The TEXT arm reads the pinned revision's bytes
// through `resolveArtifactVersionForServe` + the local blob store — the same
// canonical server-side read the artifact page's own markdown handler uses. The
// CONFIGURATION arm needs no read at all: a dashboard revision's pinned
// configuration travels on the member the gate already resolved, with its own
// stable digest. The `page` class (a `connectorRef` revision's remote content)
// has no server-side reader on this surface, so it answers `null` and the
// channel says `absent` — the same honest absence it says today, and named here
// rather than hidden behind a comment.
// ---------------------------------------------------------------------------

/** The pinned revision's bytes as text, or `null` when they cannot be read. */
async function readPinnedRevisionText(input: {
  orgId: string;
  artifactId: string;
  representationRevisionId: string;
}): Promise<string | null> {
  try {
    // THE RESOLUTION READS THE DATABASE, so it belongs INSIDE the guard with
    // the read it addresses (corrected at convergence). Outside it, a resolver
    // that threw rejected `buildProps`, and the preparation core has no catch
    // of its own: one unreadable revision took the WHOLE review surface down
    // instead of flooring one target, which is the opposite of the channel's
    // "every failure is a named absence" contract.
    const resolved = resolveArtifactVersionForServe({
      orgId: input.orgId,
      artifactId: input.artifactId,
      representationRevisionId: input.representationRevisionId,
    });
    if (!resolved) return null;
    const store = createLocalDiskBlobStore();
    const handle = await store.openByStorageKey({
      orgId: input.orgId,
      storageKey: resolved.storageKey,
    });
    // AND IT READS ONLY WHAT THE CHANNEL CAN CARRY (corrected at convergence).
    // The projection is capped; buffering the whole object before the cap is
    // applied let one authorized multi-megabyte text revision cost the server
    // its full size for a payload that can never exceed the cap. Reading one
    // byte PAST the cap keeps the channel's own `truncated` reading true.
    const budget = artifactContentCapFor("text") + 1;
    const chunks: Buffer[] = [];
    let read = 0;
    for await (const chunk of handle.stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      chunks.push(buf);
      read += buf.byteLength;
      if (read >= budget) break;
    }
    return Buffer.concat(chunks).toString("utf8");
  } catch {
    // A read that fails is an absence, never a throw: the channel's own contract
    // is that "every failure is a NAMED absence", and the display floors on it.
    return null;
  }
}

/** The substance read for ONE pinned review target, over the member the gate
 *  already resolved. Exported shape kept injectable so the wiring is testable
 *  without a blob store. */
export function reviewTargetSubstancePorts(
  member: NonNullable<RevisionMemberOutcome>,
): ArtifactContentChannelPorts {
  return {
    async readPinnedSubstance(input) {
      if (input.contentClass === "configuration") {
        const configuration = member.configuration;
        // A configuration with no recorded digest is not a configuration this
        // channel can project: the digest is what a data capability is sealed
        // to, and minting one here would seal it to a value the gate never
        // recorded. It answers an absence, which the display floors on.
        if (configuration === undefined || configuration === null) return null;
        if (!member.configurationDigest) return null;
        return {
          class: "configuration",
          configuration,
          digest: member.configurationDigest,
        };
      }
      if (input.contentClass === "text") {
        const text = await readPinnedRevisionText({
          orgId: input.orgId,
          artifactId: input.artifactId,
          representationRevisionId: input.representationRevisionId,
        });
        return text === null ? null : { class: "text", text };
      }
      return null;
    },
  };
}

/** Build ONE review target's content projection. The form is the SUBSTRATE's own
 *  (`member.form`, defaulting to `file` exactly as `isFileFormMember` reads it),
 *  never a caller claim. */
export async function buildReviewTargetContentProjection(
  input: {
    orgId: string;
    artifactId: string;
    representationRevisionId: string;
    mime: string;
    member: NonNullable<RevisionMemberOutcome>;
  },
  ports: ArtifactContentChannelPorts = reviewTargetSubstancePorts(input.member),
): Promise<ArtifactContentProjection> {
  const form: ArtifactRepresentationForm = input.member.form ?? "file";
  return buildArtifactContentProjection(
    {
      orgId: input.orgId,
      artifactId: input.artifactId,
      representationRevisionId: input.representationRevisionId,
      form,
      mime: input.mime,
    },
    ports,
  );
}
