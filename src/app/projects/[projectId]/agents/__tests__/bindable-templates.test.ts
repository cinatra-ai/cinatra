/**
 * Pure unit tests for the #1503 bind-picker helpers (design cinatra#1509
 * §4.4).
 *
 * The contract under test:
 *  - `hasProjectBindAuthority` mirrors the bind (create) handler's gate:
 *    platform_admin bypass, else a canonical grant for THIS project with role
 *    rank >= write — read-rank grants and other-project grants never pass;
 *  - `toBindableTemplates` projects the installed-agents catalog onto the
 *    picker shape: already-bound ids excluded, unkeyable (no packageId)
 *    entries dropped, deduped, name-sorted, nameless entries fall back to the
 *    id (never a nameless row);
 *  - `filterBindableTemplates` is the client-side catalog filter —
 *    case-insensitive over name, template id, and description.
 */
import { describe, it, expect } from "vitest";

import {
  filterBindableTemplates,
  hasProjectBindAuthority,
  toBindableTemplates,
  type BindableAgentTemplate,
} from "../bindable-templates";

const grant = (
  projectId: string,
  effectiveRole: "read" | "write" | "admin" | "owner",
) => ({ projectId, effectiveRole, accessSource: "user" as const });

describe("hasProjectBindAuthority", () => {
  it("passes platform admins regardless of grants", () => {
    expect(
      hasProjectBindAuthority({
        platformAdmin: true,
        projectGrants: [],
        projectId: "p1",
      }),
    ).toBe(true);
  });

  it("passes write, admin, and owner grants on the target project", () => {
    for (const role of ["write", "admin", "owner"] as const) {
      expect(
        hasProjectBindAuthority({
          platformAdmin: false,
          projectGrants: [grant("p1", role)],
          projectId: "p1",
        }),
      ).toBe(true);
    }
  });

  it("denies a read-rank grant (bind requires write, like the create handler)", () => {
    expect(
      hasProjectBindAuthority({
        platformAdmin: false,
        projectGrants: [grant("p1", "read")],
        projectId: "p1",
      }),
    ).toBe(false);
  });

  it("denies when there is no grant for the project", () => {
    expect(
      hasProjectBindAuthority({
        platformAdmin: false,
        projectGrants: [],
        projectId: "p1",
      }),
    ).toBe(false);
  });

  it("denies a write grant that belongs to a DIFFERENT project", () => {
    expect(
      hasProjectBindAuthority({
        platformAdmin: false,
        projectGrants: [grant("p-other", "owner")],
        projectId: "p1",
      }),
    ).toBe(false);
  });
});

describe("toBindableTemplates", () => {
  const installed = [
    {
      packageId: "@cinatra-ai/agent-scrape",
      humanReadableName: "Web Scrape Agent",
      description: "Scrapes the web.",
    },
    {
      packageId: "@cinatra-ai/agent-email",
      humanReadableName: "Email Drafting Agent",
      description: "Drafts emails.",
    },
    {
      packageId: "@marcus-local/custom-agent",
      humanReadableName: "Custom Agent",
      description: "Operator-vendor authored agent.",
    },
  ];

  it("excludes already-bound template ids", () => {
    const items = toBindableTemplates(installed, ["@cinatra-ai/agent-scrape"]);
    expect(items.map((t) => t.agentTemplateId)).toEqual([
      "@marcus-local/custom-agent",
      "@cinatra-ai/agent-email",
    ]);
  });

  it("sorts by display name and maps the picker shape", () => {
    const items = toBindableTemplates(installed, []);
    expect(items).toEqual<BindableAgentTemplate[]>([
      {
        agentTemplateId: "@marcus-local/custom-agent",
        humanReadableName: "Custom Agent",
        description: "Operator-vendor authored agent.",
      },
      {
        agentTemplateId: "@cinatra-ai/agent-email",
        humanReadableName: "Email Drafting Agent",
        description: "Drafts emails.",
      },
      {
        agentTemplateId: "@cinatra-ai/agent-scrape",
        humanReadableName: "Web Scrape Agent",
        description: "Scrapes the web.",
      },
    ]);
  });

  it("drops entries without a resolvable packageId (they cannot be bound)", () => {
    const items = toBindableTemplates(
      [
        { packageId: "", humanReadableName: "Ghost", description: "" },
        { packageId: "   ", humanReadableName: "Blank", description: "" },
        ...installed.slice(0, 1),
      ],
      [],
    );
    expect(items.map((t) => t.agentTemplateId)).toEqual([
      "@cinatra-ai/agent-scrape",
    ]);
  });

  it("dedupes by template id (first entry wins)", () => {
    const items = toBindableTemplates(
      [
        installed[0],
        { ...installed[0], humanReadableName: "Duplicate Copy" },
      ],
      [],
    );
    expect(items).toHaveLength(1);
    expect(items[0].humanReadableName).toBe("Web Scrape Agent");
  });

  it("falls back to the id when the display name is empty — never a nameless row", () => {
    const items = toBindableTemplates(
      [{ packageId: "@x/unnamed", humanReadableName: "  ", description: "" }],
      [],
    );
    expect(items[0].humanReadableName).toBe("@x/unnamed");
  });
});

describe("filterBindableTemplates", () => {
  const items: BindableAgentTemplate[] = [
    {
      agentTemplateId: "@cinatra-ai/agent-scrape",
      humanReadableName: "Web Scrape Agent",
      description: "Extracts structured data from pages.",
    },
    {
      agentTemplateId: "@cinatra-ai/agent-email",
      humanReadableName: "Email Drafting Agent",
      description: "Drafts emails.",
    },
  ];

  it("returns every item for an empty / whitespace query", () => {
    expect(filterBindableTemplates(items, "")).toEqual(items);
    expect(filterBindableTemplates(items, "   ")).toEqual(items);
  });

  it("matches the display name case-insensitively", () => {
    expect(
      filterBindableTemplates(items, "wEb ScRaPe").map((t) => t.agentTemplateId),
    ).toEqual(["@cinatra-ai/agent-scrape"]);
  });

  it("matches the template/package id", () => {
    expect(
      filterBindableTemplates(items, "agent-email").map((t) => t.agentTemplateId),
    ).toEqual(["@cinatra-ai/agent-email"]);
  });

  it("matches the description", () => {
    expect(
      filterBindableTemplates(items, "structured data").map(
        (t) => t.agentTemplateId,
      ),
    ).toEqual(["@cinatra-ai/agent-scrape"]);
  });

  it("returns [] when nothing matches", () => {
    expect(filterBindableTemplates(items, "no-such-agent")).toEqual([]);
  });
});
