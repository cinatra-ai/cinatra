// Per-object-type retention policy registry.
//
// Declarative. Default `indefinite` for PoC. The restore-eligibility logic
// reads this when computing restore eligibility, and the completeness gate
// verifies it against every registered object type.
//
// Enforcement (cron / batch cleanup) is explicitly out of scope; the
// registry exists so eligibility logic can flag a future operational
// milestone's retention boundary.

import type { RetentionPolicy } from "./types";

// Object type -> policy. Keys are dotted lower-case object types as used
// in cinatra.objects.type column. When a type is not present in this map,
// the default is `indefinite`. Adding a new versioned object type without
// adding a declaration here MUST fail the retention-completeness gate;
// see scripts/audit/retention-policy-gate.mjs.
const RETENTION_POLICIES: Record<string, RetentionPolicy> = {
  // Default declaration: every versioned object type ships `indefinite` in
  // the PoC. A future ops milestone owns finite retention + a cleanup job.
  "go_to_market.account": { kind: "indefinite" },
  "go_to_market.contact": { kind: "indefinite" },
  "go_to_market.campaign": { kind: "indefinite" },
  "go_to_market.email_draft": { kind: "indefinite" },
  "go_to_market.email_recipient": { kind: "indefinite" },
  "go_to_market.recipient_selection": { kind: "indefinite" },
  "blog.project": { kind: "indefinite" },
  "blog.post": { kind: "indefinite" },
  "blog.idea": { kind: "indefinite" },
  "blog.transcript": { kind: "indefinite" },
  "blog.media": { kind: "indefinite" },
  "media.feed": { kind: "indefinite" },
  "media.media_item": { kind: "indefinite" },
  "scrape.source": { kind: "indefinite" },
  "scrape.result": { kind: "indefinite" },
  "research.target": { kind: "indefinite" },
  "research.result": { kind: "indefinite" },
  "enrichment.target": { kind: "indefinite" },
  "enrichment.result": { kind: "indefinite" },
  "ross.source": { kind: "indefinite" },
  "ross.index": { kind: "indefinite" },
  "system.note": { kind: "indefinite" },
  "list.list": { kind: "indefinite" },
  "list.member": { kind: "indefinite" },
  "dashboard.dashboard": { kind: "indefinite" },
  "artifact.semantic": { kind: "indefinite" },
  "artifact.representation": { kind: "indefinite" },
  "artifact.assertion": { kind: "indefinite" },
  // Namespaced types discovered in packages/objects/src/integration/register-types.ts.
  "@cinatra-ai/objects:object": { kind: "indefinite" },
  "@cinatra-ai/campaigns:campaign": { kind: "indefinite" },
  "@cinatra-ai/campaigns:context": { kind: "indefinite" },
  "@cinatra-ai/campaigns:recipients": { kind: "indefinite" },
  "@cinatra-ai/email:sender-identity": { kind: "indefinite" },
  "@cinatra-ai/email:sent-email": { kind: "indefinite" },
  "@cinatra-ai/email:received-reply": { kind: "indefinite" },
  "@cinatra-ai/email:thread": { kind: "indefinite" },
  // Email work-product types host-registered for the @cinatra-ai/email-artifacts
  // pack (body [draftable], recipient [snapshot]) — cinatra#1454.
  "@cinatra-ai/email:body": { kind: "indefinite" },
  "@cinatra-ai/email:recipient": { kind: "indefinite" },
  // LinkedIn member post-draft [draftable], host-registered for the
  // @cinatra-ai/linkedin-artifacts pack — cinatra#1457.
  "@cinatra-ai/linkedin:post-draft": { kind: "indefinite" },
  // Drupal external node-pointer type host-registered for the
  // @cinatra-ai/drupal-artifacts pack (drupal:node [external]) — cinatra#1465.
  "@cinatra-ai/drupal:node": { kind: "indefinite" },
  // Namespaced types registered in production via objectTypeRegistry.register
  // with a fully-qualified @cinatra-ai/<ns>:<id> identifier — surfaced by
  // scripts/audit/retention-policy-gate.mjs.
  "@cinatra-ai/entity-contacts:contact": { kind: "indefinite" },
  "@cinatra-ai/entity-accounts:account": { kind: "indefinite" },
  "@cinatra-ai/agent-builder:agent-template": { kind: "indefinite" },
  "@cinatra-ai/lists:list": { kind: "indefinite" },
  "@cinatra-ai/assets:blog-project": { kind: "indefinite" },
  "@cinatra-ai/assets:blog-idea": { kind: "indefinite" },
  "@cinatra-ai/assets:blog-post": { kind: "indefinite" },
  "@cinatra-ai/artifacts:artifact-ref": { kind: "indefinite" },
  "@cinatra-ai/artifact:object": { kind: "indefinite" },
  // The pinned CMS preview capture (cinatra#2044 S6): the page as it stood when
  // a review gate was opened. Kept INDEFINITELY on purpose — re-opening an old
  // gate must still show its ORIGINAL picture, which is the whole immutability
  // guarantee the capture exists to provide.
  "@cinatra-ai/objects:cms-preview-capture": { kind: "indefinite" },
  // The immutable CMS content snapshot (cinatra#2043 S5 capture / cinatra#2044
  // S6 review). Same reasoning as the preview capture above and the same
  // immutability contract the type declares (snapshotPolicy "none", mutability
  // "record"): the review decision BINDS to these exact fields, so the snapshot
  // a reviewer acted on must remain readable for as long as the decision does.
  "@cinatra-ai/objects:cms-content-snapshot": { kind: "indefinite" },
};

const DEFAULT_POLICY: RetentionPolicy = { kind: "indefinite" };

export function getRetentionPolicy(objectType: string): RetentionPolicy {
  return RETENTION_POLICIES[objectType] ?? DEFAULT_POLICY;
}

export function listRetentionDeclarations(): ReadonlyArray<{
  objectType: string;
  policy: RetentionPolicy;
}> {
  return Object.entries(RETENTION_POLICIES).map(([objectType, policy]) => ({
    objectType,
    policy,
  }));
}

export function hasRetentionDeclaration(objectType: string): boolean {
  return Object.prototype.hasOwnProperty.call(RETENTION_POLICIES, objectType);
}

// Used by the retention-completeness gate to cross-check that every object type
// observed in the running schema also has a declared retention policy. Missing
// types fail CI. (The dynamic-types engine was torn down — epic #1785 entry 95,
// #1793 — so every observed type is now a statically declared / installed type.)
export function listRegisteredObjectTypes(): readonly string[] {
  return Object.keys(RETENTION_POLICIES);
}
