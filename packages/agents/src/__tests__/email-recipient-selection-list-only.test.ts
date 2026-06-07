/**
 * email-recipient-selection-agent: list-only scope.
 *
 * Keep only the list branch; the list IS contacts (memberType="contact").
 * UI labels should say "contacts list", not "account scope".
 *
 * This test pins the SKILL.md / system-prompt contract: the prompt instructs
 * the LLM to ONLY support type='list', to fail/block on excess recipients
 * without silently truncating, and to defer cooldown filtering to the recipient
 * HITL.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, it, expect } from "vitest";

const oasPath = path.resolve(
  __dirname,
  "../../../../extensions/cinatra-ai/email-recipient-selection-agent/cinatra/oas.json",
);
const pkgPath = path.resolve(
  __dirname,
  "../../../../extensions/cinatra-ai/email-recipient-selection-agent/package.json",
);

const oas = JSON.parse(fs.readFileSync(oasPath, "utf8")) as Record<string, unknown>;
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { version: string };

function findApiNodeSystemPrompt(): string {
  const refs = oas.$referenced_components as Record<string, Record<string, unknown>>;
  for (const node of Object.values(refs)) {
    if (node.component_type === "ApiNode") {
      const data = node.data as Record<string, unknown> | undefined;
      const system = data?.system;
      if (typeof system === "string" && system.includes("recipient")) {
        return system;
      }
    }
  }
  return "";
}

describe("email-recipient-selection-agent - list-only scope", () => {
  it("system prompt explicitly rejects all-contacts and segment branches", () => {
    const system = findApiNodeSystemPrompt();
    expect(system).toContain("list-only recipient scope");
    expect(system).toContain("legacy 'all-contacts' and 'segment' branches were retired with the lists_* MCP primitives");
    expect(system).toContain("ONLY type='list' is supported");
  });

  it("system prompt enforces maxRecipients cap with fail/block (not truncate)", () => {
    const system = findApiNodeSystemPrompt();
    expect(system).toContain("CAP ENFORCEMENT");
    expect(system).toContain("MUST NOT exceed");
    expect(system).toContain("maxRecipients");
    expect(system).toContain("Do NOT silently truncate");
    expect(system).toContain("default 200");
  });

  it("system prompt defers cooldown filter to the recipient HITL", () => {
    const system = findApiNodeSystemPrompt();
    expect(system).toContain("email_send_events cooldown filter");
    expect(system).toContain("HITL");
  });

  it("system prompt instructs crm_list_get + crm_list_members_get + crm_contact_get pipeline only", () => {
    const system = findApiNodeSystemPrompt();
    expect(system).toContain("crm_list_get");
    expect(system).toContain("crm_list_members_get");
    expect(system).toContain("crm_contact_get");
    expect(system).not.toContain("contacts_list");
    // Legacy lists_get retired alongside the rest of the lists_* family.
    expect(system).not.toContain("lists_get");
  });

  it("package.json is at the v0.1.0 standard", () => {
    expect(pkg.version).toBe("0.1.0");
  });
});

// ---------------------------------------------------------------------------
// email-outreach-agent embedded recipients-generate subflow parity.
//
// The standalone agent above ships one prompt; the email-outreach orchestrator
// inlines an equivalent prompt under `$referenced_components.recipients-generate`
// (a duplicate of the standalone prompt shaped for the orchestrator's
// list-picker gate). The lists_* primitives are retired — this test pins
// the EMBEDDED prompt to the same CRM-facade pipeline so the email-outreach
// flow cannot regress to a retired primitive at runtime.
// ---------------------------------------------------------------------------

const outreachOasPath = path.resolve(
  __dirname,
  "../../../../extensions/cinatra-ai/email-outreach-agent/cinatra/oas.json",
);
const outreachOas = JSON.parse(fs.readFileSync(outreachOasPath, "utf8")) as Record<string, unknown>;

function findOutreachRecipientsGenerateSystem(): string {
  // The email-outreach OAS nests subflows under nested `$referenced_components`
  // maps; `recipients-generate` lives inside the recipients subflow's nested
  // map (not the top-level one). Walk recursively until we find an ApiNode
  // whose key is `recipients-generate`.
  function search(obj: unknown): string {
    if (!obj || typeof obj !== "object") return "";
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const found = search(item);
        if (found) return found;
      }
      return "";
    }
    const map = obj as Record<string, unknown>;
    const refs = map.$referenced_components;
    if (refs && typeof refs === "object" && !Array.isArray(refs)) {
      const node = (refs as Record<string, Record<string, unknown>>)["recipients-generate"];
      if (node && node.component_type === "ApiNode") {
        const data = node.data as Record<string, unknown> | undefined;
        const system = data?.system;
        if (typeof system === "string") return system;
      }
    }
    for (const v of Object.values(map)) {
      const found = search(v);
      if (found) return found;
    }
    return "";
  }
  return search(outreachOas);
}

describe("email-outreach-agent - embedded recipients-generate subflow", () => {
  it("embedded system prompt uses the CRM list pipeline (parity with the standalone agent)", () => {
    const system = findOutreachRecipientsGenerateSystem();
    expect(system).toContain("crm_list_get");
    expect(system).toContain("crm_list_members_get");
    expect(system).toContain("crm_contact_get");
    expect(system).toContain("crm_account_get");
  });

  it("embedded system prompt rejects the retired all-contacts and segment scopes", () => {
    const system = findOutreachRecipientsGenerateSystem();
    expect(system).toContain("ONLY type='list' is supported");
    expect(system).toContain("retired with the lists_* MCP primitives");
  });

  it("embedded system prompt no longer references retired primitives or entity typeHints", () => {
    const system = findOutreachRecipientsGenerateSystem();
    // Retired wire primitives.
    expect(system).not.toContain("lists_get");
    expect(system).not.toContain("lists_list");
    // Legacy entity typeHints (entity-accounts / entity-contacts are retired).
    expect(system).not.toContain("@cinatra-ai/entity-contacts:contact");
    expect(system).not.toContain("@cinatra-ai/entity-accounts:account");
    // The legacy heavy-field expansion path (objects_list-by-type → objects_get)
    // for non-list recipient scopes is gone.
    expect(system).not.toContain("objects_list");
    expect(system).not.toContain("objects_get");
  });

  it("embedded system prompt still persists the bundle via objects_save (canonical bundle persistence)", () => {
    const system = findOutreachRecipientsGenerateSystem();
    expect(system).toContain("objects_save");
    expect(system).toContain("@cinatra-ai/campaigns:recipients");
    expect(system).toContain("sourceListId");
    expect(system).toContain("sourceListName");
    expect(system).toContain("sourceListMemberType");
    expect(system).toContain("sourceListSnapshotAt");
  });
});
