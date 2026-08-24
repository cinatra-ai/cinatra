/**
 * THE CREATION FENCE, AND THE WAYS AROUND IT (cinatra#2928, epic #2926 W2a).
 *
 * The fence's whole value is that a run cannot be created outside the
 * coordinator's launch entry. A fence that only recognizes ONE spelling of the
 * call is not that — it is a naming convention with a script attached. So each
 * evasion is written down here as a fixture the scanner is run against:
 *
 *   · the bare call;
 *   · the same call reached through a namespace or an object;
 *   · an ALIASED import, after which no line in the file names the creator;
 *   · a namespace import of the store, which reaches every export by naming none;
 *   · a call written across lines.
 *
 * And the two directions the records have to hold: a module that no longer
 * creates a run may not keep its "owed" row, and a module that creates one
 * without a row fails.
 */
import { describe, expect, it } from "vitest";

import {
  CREATE_ALLOWLIST,
  OWED_BY_ADAPTER,
  PENDING_INPUT_CALLERS,
  creatorImports,
  scan,
  // eslint-disable-next-line
} from "../../../../scripts/audit/run-creation-fence.mjs";

/** Run the scanner over a made-up tree: path → source. */
async function scanTree(files: Record<string, string>) {
  return scan(Object.keys(files), async (rel: string) => files[rel]);
}

const CLEAN = `import { launchAgentRun } from "./lifecycle-coordinator";
export async function go() {
  await launchAgentRun({ producer: "x", frame: null, create: { kind: "full", input: {} }, dispatch: { kind: "enqueue", options: {} } });
}
`;

/**
 * A tree with every RECORD the scanner keeps already satisfied.
 *
 * The fence holds two ledgers besides the ban itself — the modules OWED to the
 * adapter slice, and the enumerated callers of the pre-dispatch creator — and
 * both fail on a record whose file no longer matches. A fixture tree that
 * omitted them would fail for a reason the case is not about, so every case
 * starts from a tree where the records are true and adds ONE thing.
 */
function withRecords(files: Record<string, string>) {
  const out = { ...files };
  for (const rel of Object.keys(OWED_BY_ADAPTER)) {
    out[rel] = `import { createAgentRun } from "@cinatra-ai/agents";\nawait createAgentRun({}, undefined);\n`;
  }
  for (const rel of Object.keys(PENDING_INPUT_CALLERS)) {
    if (rel.startsWith("scripts/")) continue;
    out[rel] = `await createAgentRunPendingInput({}, undefined);\n`;
  }
  return out;
}

describe("the fence refuses every shape of creating a run outside launch", () => {
  it("passes a module that only launches", async () => {
    expect(await scanTree(withRecords({ "src/lib/clean.ts": CLEAN }))).toEqual([]);
  });

  it("catches the bare call", async () => {
    const v = await scanTree(
      withRecords({ "src/lib/bare.ts": `await createAgentRun({}, undefined);\n` }),
    );
    expect(v.map((x: { file: string }) => x.file)).toContain("src/lib/bare.ts");
  });

  it("catches a NAMESPACE or object call — store.createAgentRun(…)", async () => {
    // The bare-call pattern excludes a dotted left boundary on purpose, so this
    // is the shape it cannot see and the member rule exists for.
    const v = await scanTree(
      withRecords({ "src/lib/ns.ts": `import * as store from "./store";\nawait store.createAgentRun({}, undefined);\n` }),
    );
    expect(v.map((x: { file: string }) => x.file)).toContain("src/lib/ns.ts");
  });

  it("catches an ALIASED import, where no line names the creator at all", async () => {
    const source = `import { createAgentRun as mint } from "./store";\nawait mint({}, undefined);\n`;
    // The call itself is invisible to every call pattern — this is exactly why
    // the import is the violation.
    expect(/(?<![A-Za-z0-9_.])createAgentRun\s*\(/.test("await mint({}, undefined);")).toBe(false);
    const v = await scanTree(withRecords({ "src/lib/alias.ts": source }));
    expect(v.map((x: { file: string }) => x.file)).toContain("src/lib/alias.ts");
  });

  it("catches a call written ACROSS LINES", async () => {
    const source = `import { createAgentRun } from "./store";\nawait createAgentRun(\n  {},\n  undefined,\n);\n`;
    const v = await scanTree(withRecords({ "src/lib/multiline.ts": source }));
    expect(v.map((x: { file: string }) => x.file)).toContain("src/lib/multiline.ts");
  });

  it("catches the pre-dispatch creator too — one creator closed is not the seam closed", async () => {
    const v = await scanTree(
      withRecords({
        "src/lib/pending.ts": `import { createAgentRunPendingInput } from "@cinatra-ai/agents/store";\nawait createAgentRunPendingInput({}, undefined);\n`,
      }),
    );
    expect(v.map((x: { file: string }) => x.file)).toContain("src/lib/pending.ts");
  });

  it("catches a DESTRUCTURED dynamic import — this tree uses them to keep graphs off routes", async () => {
    const source = `const { createAgentRun } = await import("./store");\nawait createAgentRun({}, undefined);\n`;
    const v = await scanTree(withRecords({ "src/lib/dyn.ts": source }));
    expect(v.map((x: { file: string }) => x.file)).toContain("src/lib/dyn.ts");
  });

  it("catches a WHOLE-MODULE dynamic import of the store — every creator, none named", async () => {
    const source = `const store = await import("@cinatra-ai/agents/store");\nawait store.createAgentRun({}, undefined);\n`;
    const v = await scanTree(withRecords({ "src/lib/dynns.ts": source }));
    expect(v.map((x: { file: string }) => x.file)).toContain("src/lib/dynns.ts");
  });

  it("does NOT refuse a namespace import of the BARREL used for readers", async () => {
    // The workspace barrel is a large READ surface, and namespace-importing it
    // is ordinary. Refusing it would block legitimate code to catch a creation
    // the member rule already catches by name.
    const source = `import * as agents from "@cinatra-ai/agents";\nconst run = await agents.readAgentRunById("r");\n${CLEAN}`;
    expect(await scanTree(withRecords({ "src/lib/reader.ts": source }))).toEqual([]);
  });

  it("STILL refuses a creator reached through that same barrel namespace", async () => {
    const source = `import * as agents from "@cinatra-ai/agents";\nawait agents.createAgentRun({}, undefined);\n`;
    const v = await scanTree(withRecords({ "src/lib/barrelns.ts": source }));
    expect(v.map((x: { file: string }) => x.file)).toContain("src/lib/barrelns.ts");
  });

  it("does NOT fire on prose that merely names a creator", async () => {
    const source = `// createAgentRun is the perimeter this module goes through launch to reach.\n${CLEAN}`;
    expect(await scanTree(withRecords({ "src/lib/prose.ts": source }))).toEqual([]);
  });

  it("does NOT fire on a TYPE-only import of the creator's input", async () => {
    const source = `import type { createAgentRun } from "./store";\n${CLEAN}`;
    expect(await scanTree(withRecords({ "src/lib/typeonly.ts": source }))).toEqual([]);
  });
});

describe("the records hold in both directions", () => {
  it("the owed ledger is EMPTY — both adapters landed (cinatra#2929)", () => {
    // W2a recorded two modules here; W2b routed both through the coordinator and
    // struck their rows. Asserted rather than left implicit, because an empty
    // ledger is the statement that every producer goes through launch, and a row
    // creeping back in should have to argue for itself in front of this line.
    expect(Object.keys(OWED_BY_ADAPTER)).toEqual([]);
  });

  it("an OWED module that stopped creating runs fails as a stale record", async () => {
    // The MECHANISM, on an injected ledger. It must stay provable with the real
    // one empty: a ratchet nobody can test is a ratchet nobody can trust the day
    // a row is added back.
    const owed = "src/lib/some-adapter.ts";
    const ledger = { [owed]: "cinatra#0000 — the slice that owes the adapter, named" };
    const files = withRecords({});
    files[owed] = CLEAN; // the adapter landed…
    const v = await scan(Object.keys(files), async (rel: string) => files[rel], { owed: ledger });
    expect(
      v.filter((x: { label: string }) => x.label === "stale record").map((x: { file: string }) => x.file),
    ).toContain(owed);
  });

  it("…and an owed module that STILL creates a run is recorded, not reported", async () => {
    const owed = "src/lib/some-adapter.ts";
    const ledger = { [owed]: "cinatra#0000 — the slice that owes the adapter, named" };
    const files = withRecords({});
    files[owed] = `import { createAgentRun } from "@cinatra-ai/agents";\nawait createAgentRun({}, undefined);\n`;
    const v = await scan(Object.keys(files), async (rel: string) => files[rel], { owed: ledger });
    expect(v).toEqual([]);
  });

  it("every owed row names its owner — an unowned record is a waiver", () => {
    for (const [rel, owner] of Object.entries(OWED_BY_ADAPTER)) {
      expect(typeof owner, rel).toBe("string");
      expect((owner as string).length, rel).toBeGreaterThan(20);
    }
  });

  it("the allowlist is the coordinator, the store, the pass-through barrel and this script — nothing else", () => {
    expect([...CREATE_ALLOWLIST].sort()).toEqual([
      "packages/agents/src/index.ts",
      "packages/agents/src/lifecycle-coordinator.ts",
      "packages/agents/src/store.ts",
      "scripts/audit/run-creation-fence.mjs",
    ]);
  });

  it("reads a creator out of an import however it is spelled", () => {
    expect(creatorImports(`import { createAgentRun } from "./store";`)).toHaveLength(1);
    expect(creatorImports(`import { createAgentRun as m } from "../store";`)).toHaveLength(1);
    expect(creatorImports(`import * as s from "./store";`)).toHaveLength(1);
    // …and NOT the barrel, which is a read surface; a creator reached through
    // it is a member call, and the member rule catches that by name.
    expect(creatorImports(`import * as s from "@cinatra-ai/agents";`)).toHaveLength(0);
    expect(creatorImports(`const { createAgentRun } = await import("./store");`)).toHaveLength(1);
    expect(creatorImports(`const s = await import("@cinatra-ai/agents/store");`)).toHaveLength(1);
    expect(creatorImports(`import {\n  createAgentRunPendingInput,\n} from "@cinatra-ai/agents/store";`)).toHaveLength(1);
    // …and not out of something that merely looks like one.
    expect(creatorImports(`import { createAgentRunMetrics } from "./store";`)).toHaveLength(0);
    expect(creatorImports(`import { createAgentRun } from "./somewhere-else";`)).toHaveLength(0);
  });
});
