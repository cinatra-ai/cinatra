import { describe, it, expect } from "vitest";

import {
  humanizeTypeLocalPart,
  deriveTypeDefinitionRows,
} from "../type-definitions-inventory";
import { artifactKindLabelFor } from "../artifact-kind-label";

describe("humanizeTypeLocalPart", () => {
  it("humanizes the local part after the namespace separator (sentence case)", () => {
    expect(humanizeTypeLocalPart("@acme/support:case")).toBe("Case");
    expect(humanizeTypeLocalPart("@cinatra-ai/email:draft")).toBe("Draft");
    expect(humanizeTypeLocalPart("@cinatra-ai/email:thread")).toBe("Thread");
    expect(humanizeTypeLocalPart("@x/y:post-draft")).toBe("Post draft");
  });

  it("falls back to the whole id when there is no namespace separator", () => {
    expect(humanizeTypeLocalPart("plainthing")).toBe("Plainthing");
    expect(humanizeTypeLocalPart("multi_word_type")).toBe("Multi word type");
  });
});

// The Defined by / Used by columns no longer carry their own copy of the
// package-id derivation: they read the ONE kind label, which prefers what the
// pack declares and floors to exactly the derivation these cases pinned.
describe("the extension columns read the one declared-first kind label", () => {
  it("floors to the former derivation for a package that declares nothing", () => {
    expect(artifactKindLabelFor("@cinatra-ai/email")).toBe("Email");
    expect(artifactKindLabelFor("@cinatra-ai/prospect-lists")).toBe("Prospect Lists");
    expect(artifactKindLabelFor("@acme/support-desk")).toBe("Support Desk");
  });

  it("drops a local / version suffix before resolving", () => {
    expect(artifactKindLabelFor("@cinatra-ai/email:draft")).toBe("Email");
    expect(artifactKindLabelFor("@cinatra-ai/email@1.2.0")).toBe("Email");
  });

  it("prefers the DECLARED label over the derivation", () => {
    expect(artifactKindLabelFor("@cinatra-ai/zip-artifact")).toBe("Archive");
  });
});

describe("deriveTypeDefinitionRows", () => {
  it("builds alphabetical rows with defined-by + used-by from dependency edges", () => {
    const rows = deriveTypeDefinitionRows({
      types: [
        { typeId: "@cinatra-ai/email:draft", definer: "@cinatra-ai/email" },
        { typeId: "@acme/support:case", definer: "@acme/support-desk" },
        { typeId: "@cinatra-ai/email:thread", definer: "@cinatra-ai/email" },
      ],
      installed: [
        { packageName: "@cinatra-ai/email", dependencies: [] },
        { packageName: "@acme/support-desk", dependencies: [] },
        {
          packageName: "@acme/escalations",
          dependencies: [{ packageName: "@acme/support-desk" }],
        },
        {
          packageName: "@cinatra-ai/sequences",
          dependencies: [{ packageName: "@cinatra-ai/email" }],
        },
        {
          packageName: "@cinatra-ai/inbox-zero-agent",
          dependencies: [{ packageName: "@cinatra-ai/email" }],
        },
      ],
    });

    // Alphabetical by display name: Case, Draft, Thread.
    expect(rows.map((r) => r.displayName)).toEqual(["Case", "Draft", "Thread"]);

    const caseRow = rows[0];
    expect(caseRow.typeId).toBe("@acme/support:case");
    expect(caseRow.definedByLabel).toBe("Support Desk");
    expect(caseRow.usedByLabels).toEqual(["Escalations"]);

    const draftRow = rows[1];
    expect(draftRow.definedByLabel).toBe("Email");
    // Both dependents surface, humanized + alphabetical.
    expect(draftRow.usedByLabels).toEqual(["Inbox Zero Agent", "Sequences"]);

    const threadRow = rows[2];
    expect(threadRow.definedByLabel).toBe("Email");
    // No dependent declares the thread type's definer beyond draft's — email is
    // the same definer, so thread shares draft's dependents. Assert it is the
    // same non-empty set (dependents are per-DEFINER, not per-type).
    expect(threadRow.usedByLabels).toEqual(["Inbox Zero Agent", "Sequences"]);
  });

  it("never lists a package as a dependent of itself", () => {
    const rows = deriveTypeDefinitionRows({
      types: [{ typeId: "@x/pkg:t", definer: "@x/pkg" }],
      installed: [
        // A self-referential edge must be ignored.
        { packageName: "@x/pkg", dependencies: [{ packageName: "@x/pkg" }] },
      ],
    });
    expect(rows[0].usedByLabels).toEqual([]);
  });

  it("renders a host-built-in (provenance-less) type with a dash defined-by and no dependents", () => {
    const rows = deriveTypeDefinitionRows({
      types: [{ typeId: "@cinatra-ai/objects:builtin", definer: null }],
      installed: [
        {
          packageName: "@some/dependent",
          dependencies: [{ packageName: "@cinatra-ai/objects" }],
        },
      ],
    });
    expect(rows[0].definedByPackage).toBeNull();
    expect(rows[0].definedByLabel).toBe("—");
    // A null definer can never match a dependency edge.
    expect(rows[0].usedByLabels).toEqual([]);
  });

  it("deduplicates dependents that declare the definer more than once", () => {
    const rows = deriveTypeDefinitionRows({
      types: [{ typeId: "@x/a:t", definer: "@x/a" }],
      installed: [
        {
          packageName: "@x/b",
          dependencies: [{ packageName: "@x/a" }, { packageName: "@x/a" }],
        },
      ],
    });
    expect(rows[0].usedByLabels).toEqual(["B"]);
  });
});
