/**
 * Lifecycle D W6 — every bridge output declares the members it reaches.
 *
 * cinatra#2959. The runtime asks the model for exactly the shape an agent
 * declares: an object level with NO declared members is sent CLOSED and EMPTY
 * (the strict structured-output contract has no open map), so an undeclared
 * list comes back as empty objects on the credential-free path.
 *
 * This file is the host's durable arm for that rule. It reads the SYNCED
 * pinned tree — the real service descriptions at the pins this repository
 * commits, never a stub — the same way `lifecycle-d-w6-fleet-declarations.ts`
 * reads it, and reddens when a bridge node output reaches an object level that
 * declares no members.
 *
 * The border is unchanged: a declaration lives in the agent's own repository
 * and is changed by a pull request there. Nothing here edits an extension.
 * This is the host's read of the pinned result, so a pin that LOSES a
 * declaration — or a new agent that never carried one — reddens here instead
 * of shipping quietly.
 *
 * The classification mirrors the runtime's own derivation
 * (`_derive_bridge_output_schemas` and its helpers in
 * `docker/wayflow/agent_loader.py`): only ApiNodes addressing `/api/llm-bridge`
 * are bridge nodes; an authored `data.output_schema` is an override the pass
 * never touches; a node whose outputs are not ALL usable derives nothing; and
 * both agentspec spellings of a declaration (a top-level `properties`/`items`
 * and the nested `json_schema` one) are the same declaration.
 *
 * An output may stay open ONLY where its own description records why. The four
 * that do are named below, so the exemption is stated rather than allowed by a
 * silent list: each is a caller-shaped payload whose members are chosen per run.
 *
 * Run `node scripts/ci/sync-dev-extensions.mjs --pinned` before this suite or
 * its first case fails by design.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, it, expect } from "vitest";

const extensionsRoot = path.resolve(__dirname, "../../../../extensions/cinatra-ai");

/** The pins this repository commits — the authority on what the sync owes. */
const DEV_LOCK = path.resolve(__dirname, "../../../../cinatra-dev-extensions.lock.json");

/** Every package the dev lock pins, by the directory the sync materializes. */
function lockedSlugs(): string[] {
  const lock = JSON.parse(fs.readFileSync(DEV_LOCK, "utf8")) as {
    packages?: { packageName?: unknown }[];
  };
  const packages = Array.isArray(lock.packages) ? lock.packages : [];
  return packages
    .map((entry) => (typeof entry.packageName === "string" ? entry.packageName : ""))
    .filter((name) => name.startsWith("@cinatra-ai/"))
    .map((name) => name.slice("@cinatra-ai/".length))
    .sort();
}

/** Only an ApiNode on this host route addresses the model bridge. */
const LLM_BRIDGE_PATH = "/api/llm-bridge";

/**
 * The outputs that stay open ON PURPOSE. `because` is the fragment that output's
 * OWN description has to carry — asserted below, so the reason is read from the
 * pinned declaration rather than restated here and never checked.
 */
const INTENTIONALLY_FREE_FORM = [
  {
    slug: "list-curator-agent",
    node: "propose",
    path: "outputSchema",
    because: "the person edits as text at the schema_gate review",
  },
  {
    slug: "list-curator-agent",
    node: "collect",
    path: "candidateMembers[]",
    because: "dictated by the outputSchema the person approved for this run",
  },
  {
    slug: "web-research-agent",
    node: "research",
    path: "enrichedRows[]",
    because: "The per-row shape is the caller's own",
  },
  {
    slug: "web-scrape-agent",
    node: "extract",
    path: "items[]",
    because: "each item conforms to the caller-supplied",
  },
] as const;

/** The phrase every one of the four carries in its own OAS description. */
const RECORDED_REASON = /intentionally free-form/i;

type Finding = {
  slug: string;
  node: string;
  path: string;
  reasonRecorded: boolean;
  /** The output's own description, as pinned — "" when it declares none. */
  description: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The member map a declaration carries, in EITHER spelling; empty is none. */
function declaredMembers(node: unknown): Record<string, unknown> | null {
  if (!isPlainObject(node)) return null;
  let members = node.properties;
  if (!isPlainObject(members)) {
    const nested = node.json_schema;
    members = isPlainObject(nested) ? nested.properties : undefined;
  }
  if (!isPlainObject(members)) return null;
  return Object.keys(members).length > 0 ? members : null;
}

/** The item declaration a declaration carries, in EITHER spelling. */
function declaredItems(node: unknown): unknown {
  if (!isPlainObject(node)) return undefined;
  // The runtime's `_declared_items` falls back to the nested spelling when the
  // top-level key is ABSENT OR NULL (`if items is None`), so an explicit
  // `"items": null` beside a `json_schema.items` declaration reads as the
  // nested declaration here too, never as "no items declared".
  if (node.items !== undefined && node.items !== null) return node.items;
  const nested = node.json_schema;
  const nestedItems = isPlainObject(nested) ? nested.items : undefined;
  return nestedItems === null ? undefined : nestedItems;
}

/** Every type a declaration names — the nullable list spelling included. */
function declaredTypes(node: unknown): string[] {
  if (!isPlainObject(node)) return [];
  const declared = node.type;
  if (typeof declared === "string") return [declared];
  if (Array.isArray(declared)) return declared.filter((e): e is string => typeof e === "string");
  return [];
}

/** Object levels reached through these are validated exactly the same way. */
const BRANCH_KEYWORDS = ["anyOf", "oneOf", "allOf"] as const;

/** Walk one declared subschema, collecting every level that declares nothing. */
function walkSubschema(node: unknown, at: string, freeForm: string[]): void {
  if (!isPlainObject(node)) return;
  const members = declaredMembers(node);
  if (members !== null) {
    for (const [name, member] of Object.entries(members)) {
      walkSubschema(member, `${at}.${name}`, freeForm);
    }
  } else if (declaredTypes(node).includes("object")) {
    freeForm.push(at);
  }
  for (const keyword of BRANCH_KEYWORDS) {
    const branches = node[keyword];
    if (Array.isArray(branches)) {
      branches.forEach((branch, index) =>
        walkSubschema(branch, `${at}|${keyword}[${index}]`, freeForm),
      );
    }
  }
  const items = declaredItems(node);
  if (Array.isArray(items)) {
    items.forEach((item, index) => walkSubschema(item, `${at}[${index}]`, freeForm));
  } else if (items !== undefined && items !== null) {
    walkSubschema(items, `${at}[]`, freeForm);
  } else if (declaredTypes(node).includes("array")) {
    freeForm.push(`${at}[]`);
  }
}

/**
 * One declared output -> the levels it leaves open, or `null` when the output
 * is unusable (no plain `title`/`type`), which makes the runtime derive NO
 * schema for the whole node rather than a partial one.
 */
function outputFreeForm(prop: unknown): string[] | null {
  if (!isPlainObject(prop)) return null;
  const title = prop.title;
  const type = prop.type;
  if (typeof title !== "string" || !title) return null;
  if (typeof type !== "string" || !type) return null;

  const freeForm: string[] = [];
  const members = declaredMembers(prop);
  if (members !== null) {
    for (const [name, member] of Object.entries(members)) {
      walkSubschema(member, `${title}.${name}`, freeForm);
    }
  } else if (type === "object") {
    freeForm.push(title);
  }
  const items = declaredItems(prop);
  if (Array.isArray(items)) {
    items.forEach((item, index) => walkSubschema(item, `${title}[${index}]`, freeForm));
  } else if (items !== undefined && items !== null) {
    walkSubschema(items, `${title}[]`, freeForm);
  } else if (type === "array") {
    freeForm.push(`${title}[]`);
  }
  return freeForm;
}

/** Every bridge-node output level left open in one agent's pinned OAS. */
function findingsFor(slug: string): Finding[] {
  const file = path.join(extensionsRoot, slug, "cinatra", "oas.json");
  // An unreadable or malformed service description must REDDEN: swallowing it
  // would drop that package's bridge nodes out of the scan and read as clean.
  let doc: unknown;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `unreadable or malformed pinned service description: ${file} — ${String(error)}`,
    );
  }

  const findings: Finding[] = [];

  const visit = (node: Record<string, unknown>): void => {
    const data = node.data;
    if (!isPlainObject(data)) return;
    // An authored shape is an override the derivation never overwrites.
    if (data.output_schema !== undefined && data.output_schema !== null) return;
    const outputs = node.outputs;
    if (!Array.isArray(outputs) || outputs.length === 0) return;

    // Mirrors the runtime's `node.get("id") or node.get("name")`: an EMPTY or
    // non-string id falls through to the name rather than reporting "".
    const declaredId = typeof node.id === "string" && node.id ? node.id : undefined;
    const declaredName = typeof node.name === "string" && node.name ? node.name : undefined;
    const nodeId = declaredId ?? declaredName ?? "";
    const collected: Finding[] = [];
    for (const prop of outputs) {
      const open = outputFreeForm(prop);
      // One unusable output and the runtime derives nothing for the node.
      if (open === null) return;
      const descriptionValue = isPlainObject(prop) ? prop.description : undefined;
      const reasonRecorded =
        typeof descriptionValue === "string" && RECORDED_REASON.test(descriptionValue);
      const description = typeof descriptionValue === "string" ? descriptionValue : "";
      for (const at of open) {
        collected.push({ slug, node: nodeId, path: at, reasonRecorded, description });
      }
    }
    // The runtime reports each free-form path ONCE per node (`sorted(set(...))`),
    // so two outputs of one node that reach the same path are one finding here.
    const seen = new Set<string>();
    findings.push(
      ...collected.filter((f) => {
        if (seen.has(f.path)) return false;
        seen.add(f.path);
        return true;
      }),
    );
  };

  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (!isPlainObject(node)) return;
    const url = node.url;
    if (
      node.component_type === "ApiNode" &&
      typeof url === "string" &&
      url.endsWith(LLM_BRIDGE_PATH)
    ) {
      visit(node);
    }
    for (const value of Object.values(node)) walk(value);
  };

  walk(doc);
  return findings;
}

function pinnedSlugs(): string[] {
  return fs
    .readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((slug) => fs.existsSync(path.join(extensionsRoot, slug, "cinatra", "oas.json")))
    .sort();
}

describe("cinatra#2959 — the pinned tree is the ground this suite reads", () => {
  it("the extension tree is materialized (run the dev-extension sync first)", () => {
    expect(fs.existsSync(extensionsRoot)).toBe(true);
    const slugs = pinnedSlugs();
    expect(slugs.length).toBeGreaterThan(0);
    // A PARTIAL sync would shrink this suite's input set in silence, so every
    // package the dev lock pins must be on disk before anything below reads a
    // declaration. The scan itself is WIDER than the lock on purpose: the tree
    // also carries packages this lock does not pin (the code reviewer, linter,
    // planner, author and security reviewer agents), and a bridge output of
    // theirs is held to the same rule.
    const locked = lockedSlugs();
    expect(locked.length).toBeGreaterThan(0);
    expect(locked.filter((slug) => !fs.existsSync(path.join(extensionsRoot, slug)))).toEqual([]);
    // Every package named by the exemptions below must really be on the pin,
    // or an exemption could pass by being absent rather than by being read.
    const named = [...new Set(INTENTIONALLY_FREE_FORM.map((e) => e.slug))].sort();
    expect(named.filter((slug) => !slugs.includes(slug))).toEqual([]);
  });
});

describe("cinatra#2959 — every bridge output declares the members it reaches", () => {
  it("no bridge output reaches an object level with no declared members", () => {
    const undeclared = pinnedSlugs()
      .flatMap((slug) => findingsFor(slug))
      .filter((f) => !f.reasonRecorded)
      .map((f) => `${f.slug} ${f.node}/${f.path}`)
      .sort();
    expect(undeclared).toEqual([]);
  });

  it("the outputs that stay open are exactly the four whose description says why", () => {
    const exempt = pinnedSlugs()
      .flatMap((slug) => findingsFor(slug))
      .filter((f) => f.reasonRecorded)
      .map((f) => `${f.slug} ${f.node}/${f.path}`)
      .sort();
    const named = INTENTIONALLY_FREE_FORM.map((e) => `${e.slug} ${e.node}/${e.path}`).sort();
    expect(exempt).toEqual(named);
  });

  it("each open output's OWN description carries the reason named for it here", () => {
    const described = new Map<string, string>(
      pinnedSlugs()
        .flatMap((slug) => findingsFor(slug))
        .map((f) => [`${f.slug} ${f.node}/${f.path}`, f.description]),
    );
    for (const exemption of INTENTIONALLY_FREE_FORM) {
      const key = `${exemption.slug} ${exemption.node}/${exemption.path}`;
      const description = described.get(key);
      expect(description, key).toBeTypeOf("string");
      expect(description, key).toMatch(RECORDED_REASON);
      // The phrase alone is not the reason: the declaration has to say WHY.
      expect(description, key).toContain(exemption.because);
    }
  });
});
