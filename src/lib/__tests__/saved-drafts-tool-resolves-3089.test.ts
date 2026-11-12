/**
 * THE PINNED DRAFTING AND OUTREACH PACKS SERVE THE DRAFTS REVIEW (cinatra#4504, #3089).
 *
 * The pin advance moves @cinatra-ai/email-drafting-agent and @cinatra-ai/email-outreach-agent to the
 * commits that declare the `saved_drafts` tool (`cinatra/tools/saved-drafts.mjs`) and, for the outreach
 * agent, the `email-drafts-review` field renderer. This file reads the REAL pinned packs, so run it after
 * `node scripts/ci/sync-dev-extensions.mjs --pinned` (the pack trees live under extensions/):
 *
 *   - the lock no longer holds the two previous pins;
 *   - for each pack, `saved_drafts` is found in the pack's own `cinatra.tools` (parseDeclaredTools), the
 *     module path resolves inside the pack (resolveDeclaredToolModulePath), and dispatchExtensionTool
 *     loads the module through the real loader road and returns the saved drafts under
 *     `draftBundle.draftedEmails`, in the saved order;
 *   - a call with no reference is refused as the host's own one-sentence refusal;
 *   - the generated binding map holds the outreach agent's `email-drafts-review` binding.
 *
 * Red first: with the lock and the synced packs at the previous pins, the tool name is declared by
 * neither pack and the binding line is absent.
 *
 *   pnpm vitest run src/lib/__tests__/saved-drafts-tool-resolves-3089.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseDeclaredTools } from "@cinatra-ai/sdk-extensions/manifest";
import { GENERATED_FIELD_RENDERER_BINDINGS } from "@/lib/generated/agent-bindings";
import { dispatchExtensionTool, ExtensionToolRefusal } from "@/lib/extension-tool-dispatch";
import { resolveDeclaredToolModulePath } from "@/lib/extension-tool-module-loader";

const REPO_ROOT = process.cwd();
const DRAFTING = "@cinatra-ai/email-drafting-agent";
const OUTREACH = "@cinatra-ai/email-outreach-agent";
const PREVIOUS_PINS: Record<string, string> = {
  [DRAFTING]: "faf05c2afee7e78412978f2e646e2c3273c48837",
  [OUTREACH]: "92874fdd00de8ad63fc585c68598b08f4ea7fd85",
};
const BUNDLE_TYPE = "@cinatra-ai/campaigns:email-draft-bundle";

function lockPin(file: string, packageName: string): string {
  const lock = JSON.parse(readFileSync(path.join(REPO_ROOT, file), "utf8")) as {
    packages: Array<{ packageName: string; resolvedSha: string }>;
  };
  const entry = lock.packages.find((p) => p.packageName === packageName);
  if (!entry) throw new Error(`${packageName} is not in ${file}`);
  return entry.resolvedSha;
}

function packRoot(packageName: string): string {
  return path.join(REPO_ROOT, "extensions", packageName.replace("@", "").replace("/", path.sep));
}

function packJson(packageName: string): { version: string; cinatra: Record<string, unknown> } {
  return JSON.parse(readFileSync(path.join(packRoot(packageName), "package.json"), "utf8"));
}

const DRAFTS = [
  { id: "d1", recipientEmail: "a@example.com", subject: "S1", body: "B1" },
  { id: "d2", recipientEmail: "b@example.com", subject: "S2", body: "B2" },
];

function ports(read: (a: { objectId: string }) => Promise<unknown>) {
  return {
    data: {},
    artifacts: {},
    clock: { now: () => new Date("2026-11-08T00:00:00.000Z") },
    objects: { read, save: async () => ({ objectId: "x", type: "x", isNew: true }) },
  } as never;
}

describe("the lock pins the packs that serve the drafts review (cinatra#4504)", () => {
  it.each([DRAFTING, OUTREACH])("%s is no longer at its previous pin", (name) => {
    const pin = lockPin("cinatra-dev-extensions.lock.json", name);
    expect(pin).toMatch(/^[0-9a-f]{40}$/);
    expect(pin).not.toBe(PREVIOUS_PINS[name]);
  });
});

describe.each([DRAFTING, OUTREACH])("%s saved_drafts through the real loader road", (name) => {
  it("declares saved_drafts and returns the saved drafts under draftBundle.draftedEmails", async () => {
    const pkg = packJson(name);
    const declared = parseDeclaredTools(pkg.cinatra.tools, name);
    const tool = declared.find((t) => t.name === "saved_drafts");
    expect(tool, `${name} declares saved_drafts`).toBeDefined();
    expect(resolveDeclaredToolModulePath(packRoot(name), tool!.module)).not.toBeNull();

    const read = async (a: { objectId: string }) => {
      expect(a).toEqual({ objectId: "bundle-1" });
      return { objectId: "bundle-1", type: BUNDLE_TYPE, data: { draftedEmails: DRAFTS } };
    };
    const result = (await dispatchExtensionTool({
      packageName: name,
      packageVersion: pkg.version,
      orgId: "org-1",
      cinatra: pkg.cinatra,
      request: { name: "saved_drafts", input: { draftBundleRef: "bundle-1" } },
      ports: ports(read),
      deps: { resolvePackageRoot: async () => packRoot(name) },
    })) as { ok: boolean; draftBundle: { draftedEmails: Array<Record<string, unknown>> } };
    expect(result.ok).toBe(true);
    expect(result.draftBundle.draftedEmails).toEqual(DRAFTS);
  });

  it("refuses a call with no reference as the host's own one-sentence refusal", async () => {
    const pkg = packJson(name);
    const rejection = await dispatchExtensionTool({
      packageName: name,
      packageVersion: pkg.version,
      orgId: "org-1",
      cinatra: pkg.cinatra,
      request: { name: "saved_drafts", input: {} },
      ports: ports(async () => null),
      deps: { resolvePackageRoot: async () => packRoot(name) },
    }).catch((e: unknown) => e);
    expect(rejection).toBeInstanceOf(ExtensionToolRefusal);
    expect((rejection as Error).message).toContain("refused the call:");
    expect((rejection as Error).message).toContain("names no saved draft bundle");
  });
});

describe("the generated binding map holds the outreach drafts review (cinatra#4504)", () => {
  it("has @cinatra-ai/email-outreach-agent:email-drafts-review, a mid-run review of kind email-drafts-review", () => {
    const b = GENERATED_FIELD_RENDERER_BINDINGS.find(
      (x) => x.id === "@cinatra-ai/email-outreach-agent:email-drafts-review",
    );
    expect(b).toMatchObject({
      kind: "email-drafts-review",
      priority: 70,
      midRunHitl: true,
      declaredBy: "@cinatra-ai/email-outreach-agent",
    });
  });
});
