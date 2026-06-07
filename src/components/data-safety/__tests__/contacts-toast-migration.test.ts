// Contacts migration source-pins: objects_save changeSetId enabler, the
// generic <MutationResultForm>, contacts forms wired, and the inventory
// reflecting update+create MIGRATED / delete PENDING.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");

describe("objects_save changeSetId enabler (create path)", () => {
  it("objects_save surfaces changeSetId; client.save types it optional", () => {
    expect(read("packages/objects/src/mcp/handlers.ts")).toMatch(
      /changeSetId: record\.changeSetId/,
    );
    expect(read("packages/objects/src/mcp/client/deterministic-client.ts")).toMatch(
      /confidence: number; changeSetId\?: string/,
    );
  });
});

describe("MutationResultForm is generic (typed successHref result)", () => {
  const src = read("src/components/data-safety/mutation-result-form.tsx");
  it("declares a generic T flowing from the action's MutationResult<T>", () => {
    expect(src).toMatch(/export function MutationResultForm<T = unknown>/);
    expect(src).toMatch(/action: \(formData: FormData\) => Promise<MutationResult<T>>/);
    expect(src).toMatch(/Extract<MutationResult<T>, \{ ok: true \}>/);
  });
});

// The contacts edit/create-form + contacts inventory blocks were removed:
// the entity-contacts CRM write surface (pages.tsx + create-contact-form.tsx +
// actions.ts) was retired in the Twenty migration. CRM contacts live in Twenty
// (no cinatra-side UI); the chat-side lookup is the read-only
// crm-contact-finder widget. The objects_save changeSetId enabler + the
// generic MutationResultForm contract above remain valid for the surviving
// (non-CRM) object write surfaces.
