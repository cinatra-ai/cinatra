/**
 * THE OWNER OF AN ARTIFACT TYPE COMES FROM ITS REGISTRATION, NOT FROM ITS NAME
 * (cinatra#3597, epic #2926).
 *
 * The issue's own sentence: "An agent that declares an artifact package may read
 * every type that package has registered, whatever the type's id looks like; an
 * agent that does not declare the owning package is still refused. The owner of a
 * type comes from the type's registration, never from its name."
 *
 * Five shipped artifact packages register types whose id namespace is not their
 * package name (`@cinatra-ai/linkedin-artifacts` registers
 * `@cinatra-ai/linkedin:post-draft`, the email artifacts register four
 * `@cinatra-ai/email:*` types, and so on), so a split of the id at its last colon
 * names a package that does not exist and refuses the declaring caller.
 *
 * The claim reading is injected here, so these cases drive the REAL
 * `resolveArtifactDependencyAdmission` without a database.
 */
import { describe, expect, it } from "vitest";

import type { ArbitrableClaim } from "@cinatra-ai/objects/claims";
import {
  admitsArtifactType,
  resolveArtifactDependencyAdmission,
} from "@/lib/artifacts/extension-artifact-admission";

const ORG = "org-3597";
const CALLER = "@cinatra-ai/blog-linkedin-publish-agent";

const LINKEDIN_PKG = "@cinatra-ai/linkedin-artifacts";
const LINKEDIN_TYPE = "@cinatra-ai/linkedin:post-draft";
const EMAIL_PKG = "@cinatra-ai/email-artifacts";
const EMAIL_TYPE = "@cinatra-ai/email:body";
const OTHER_PKG = "@cinatra-ai/brand-voice-artifact";
/** A live competitor for EMAIL_TYPE at the weaker (platform) precedence rank. */
const PLATFORM_RANK_PKG = "@cinatra-ai/platform-email-artifacts";
/** A live claimant for EMAIL_TYPE in an organisation outside this run's chain. */
const FOREIGN_ORG_PKG = "@cinatra-ai/foreign-email-artifacts";

/** One row of the org's claim chain, in the shape arbitration reads. */
function claim(input: {
  id: string;
  objectTypeId: string;
  extensionPackage: string;
  status?: ArbitrableClaim["status"];
  scope?: string;
  claimKind?: ArbitrableClaim["claimKind"];
  generation?: number;
}): ArbitrableClaim {
  return {
    id: input.id,
    scope: (input.scope ?? "platform") as ArbitrableClaim["scope"],
    objectTypeId: input.objectTypeId,
    claimKind: input.claimKind ?? "dedicated",
    status: input.status ?? "active",
    extensionPackage: input.extensionPackage,
    extensionVersion: "0.1.0",
    generation: input.generation ?? 1,
  };
}

/** An artifact dependency edge on the caller's own manifest. */
const artifactEdge = (packageName: string) => ({
  packageName,
  kind: "artifact",
  edgeType: "runtime",
  versionConstraint: { kind: "semver-range", range: "^0.1.0" },
  requirement: "required",
});

function admissionFor(input: {
  declares: string[];
  claims: readonly ArbitrableClaim[];
}) {
  return resolveArtifactDependencyAdmission({
    packageName: CALLER,
    packageVersion: "0.5.3",
    orgId: ORG,
    cinatra: { dependencies: input.declares.map(artifactEdge) },
    readClaims: () => input.claims,
  });
}

describe("the admission reads a type's owner from its registration", () => {
  it("admits a declared package's type whose id namespace is NOT the package name", () => {
    const admission = admissionFor({
      declares: [LINKEDIN_PKG],
      claims: [claim({ id: "c1", objectTypeId: LINKEDIN_TYPE, extensionPackage: LINKEDIN_PKG })],
    });
    expect(admission.admittedPackages).toEqual([LINKEDIN_PKG]);
    expect(admitsArtifactType(admission, LINKEDIN_TYPE)).toBe(true);
  });

  it("refuses that same type to a caller that declares a DIFFERENT artifact package", () => {
    const admission = admissionFor({
      declares: [OTHER_PKG],
      claims: [claim({ id: "c1", objectTypeId: LINKEDIN_TYPE, extensionPackage: LINKEDIN_PKG })],
    });
    expect(admitsArtifactType(admission, LINKEDIN_TYPE)).toBe(false);
  });

  it("FAILS CLOSED for a type no active claim names an owner for, however its id reads", () => {
    const admission = admissionFor({
      declares: [LINKEDIN_PKG],
      claims: [claim({ id: "c1", objectTypeId: LINKEDIN_TYPE, extensionPackage: LINKEDIN_PKG })],
    });
    // The id's namespace IS a package this caller declares — and it is still
    // refused, because no active claim says that package owns this type.
    expect(admitsArtifactType(admission, `${LINKEDIN_PKG}:unclaimed`)).toBe(false);
  });

  it("follows the WINNING claim, not any claim the org chain carries", () => {
    const claims = [
      claim({
        id: "c-retired",
        objectTypeId: EMAIL_TYPE,
        extensionPackage: "@cinatra-ai/legacy-email-artifacts",
        status: "retired",
      }),
      // A LIVE competitor at the weaker platform rank: the winner must be
      // chosen by arbitration and not merely by lifecycle.
      claim({
        id: "c-platform-active",
        objectTypeId: EMAIL_TYPE,
        extensionPackage: PLATFORM_RANK_PKG,
      }),
      // A live claim in ANOTHER organisation's scope: outside this chain.
      claim({
        id: "c-foreign-org",
        objectTypeId: EMAIL_TYPE,
        extensionPackage: FOREIGN_ORG_PKG,
        scope: "org:some-other-org",
      }),
      claim({
        id: "c-winner",
        objectTypeId: EMAIL_TYPE,
        extensionPackage: EMAIL_PKG,
        scope: `org:${ORG}`,
      }),
    ];
    expect(
      admitsArtifactType(admissionFor({ declares: [EMAIL_PKG], claims }), EMAIL_TYPE),
    ).toBe(true);
    for (const loser of [
      "@cinatra-ai/legacy-email-artifacts",
      PLATFORM_RANK_PKG,
      FOREIGN_ORG_PKG,
    ]) {
      expect(
        admitsArtifactType(admissionFor({ declares: [loser], claims }), EMAIL_TYPE),
      ).toBe(false);
    }
  });
});
