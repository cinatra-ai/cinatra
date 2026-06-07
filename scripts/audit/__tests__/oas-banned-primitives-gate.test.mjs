import { describe, it, expect } from "vitest";
import {
  scanOasObject,
  BANNED_PRIMITIVES,
  BANNED_TYPEHINTS,
} from "../oas-banned-primitives-gate.mjs";

// Recurrence guard for the OAS-banned-primitives gate. The gate covers the
// blind spot the crm-pointer-gate leaves (it skips /cinatra/oas.json): a live
// agent OAS prompt instructing the LLM to call a retired primitive.

describe("scanOasObject — clean cases pass", () => {
  it("returns no findings for an OAS that uses only crm_* + objects_get", () => {
    const oas = {
      $referenced_components: {
        node: {
          component_type: "ApiNode",
          data: {
            system:
              "Call crm_list_get, crm_list_members_get, crm_contact_get, then objects_save the bundle. Read the draft via objects_get.",
            user: "Resolve recipients via crm_contact_find_by_email.",
          },
        },
      },
      description: "Routes through the crm_* facade.",
    };
    expect(scanOasObject(oas)).toEqual([]);
  });

  it("does NOT flag objects_get (campaign bundle reads are legitimate)", () => {
    const oas = { data: { system: "Fetch the bundle via objects_get({ objectId })." } };
    expect(scanOasObject(oas)).toEqual([]);
  });

  it("does NOT flag a retired primitive name that sits in a NON-LLM field", () => {
    // `title` / `name` / output keys are not fed to the model — only system /
    // user / description are. A retired token there must not trip the gate.
    const oas = {
      outputs: [{ title: "lists_create_result", type: "string" }],
      someKey: "accounts_list",
    };
    expect(scanOasObject(oas)).toEqual([]);
  });

  it("does NOT flag objects_list when no CRM entity type is nearby", () => {
    const oas = {
      data: {
        system: "Call objects_list({ type: '@cinatra-ai/campaigns:recipients' }).",
      },
    };
    expect(scanOasObject(oas)).toEqual([]);
  });
});

describe("scanOasObject — violations fail", () => {
  it("flags a retired primitive in a system prompt", () => {
    const oas = {
      data: { system: "First call lists_get with the listId, then expand members." },
    };
    const findings = scanOasObject(oas);
    expect(findings.length).toBeGreaterThanOrEqual(1);
    expect(findings.some((f) => f.token === "lists_get")).toBe(true);
  });

  it("flags a legacy entity typeHint in a user prompt", () => {
    const oas = {
      data: {
        user: 'Save via objects_save({ typeHint: "@cinatra-ai/entity-contacts:contact" }).',
      },
    };
    const findings = scanOasObject(oas);
    expect(
      findings.some((f) => f.token === "@cinatra-ai/entity-contacts:contact"),
    ).toBe(true);
  });

  it("flags objects_list over a CRM entity type (the heavy-field read path)", () => {
    const oas = {
      data: {
        system:
          'Call objects_list({ type: "@cinatra-ai/entity-accounts:account", query }) to dedup.',
      },
    };
    const findings = scanOasObject(oas);
    expect(
      findings.some((f) => f.token === "objects_list(<crm-entity-type>)"),
    ).toBe(true);
  });

  it("flags nested subflow prompts (recursive walk)", () => {
    const oas = {
      $referenced_components: {
        outer: {
          $referenced_components: {
            inner: {
              component_type: "ApiNode",
              data: { system: "Use accounts_create to persist." },
            },
          },
        },
      },
    };
    const findings = scanOasObject(oas);
    expect(findings.some((f) => f.token === "accounts_create")).toBe(true);
  });
});

describe("banned lists are exhaustive for the retired families", () => {
  it("covers all 8 lists_* primitives", () => {
    for (const p of [
      "lists_list",
      "lists_get",
      "lists_create",
      "lists_update",
      "lists_delete",
      "lists_members_add",
      "lists_members_remove",
      "lists_members_count",
    ]) {
      expect(BANNED_PRIMITIVES).toContain(p);
    }
  });

  it("covers both legacy entity typeHints", () => {
    expect(BANNED_TYPEHINTS).toContain("@cinatra-ai/entity-accounts:account");
    expect(BANNED_TYPEHINTS).toContain("@cinatra-ai/entity-contacts:contact");
  });

  it("does NOT ban objects_get", () => {
    expect(BANNED_PRIMITIVES).not.toContain("objects_get");
  });
});
