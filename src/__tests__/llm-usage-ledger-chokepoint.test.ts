/**
 * cinatra#2578 — the usage ledger's choke point stays a choke point.
 *
 * The defect this guards against is not a wrong number, it is a MISSING ROW.
 * `/analytics/llm` sums `cinatra.usage_events`, and before this change every row
 * came from a hand-written emit sitting next to an adapter call. A new code path
 * that reached a provider some other way was billed and invisible, and nothing
 * failed — the ledger under-reported real OpenAI spend by roughly 10x.
 *
 * The invariants below are what make the ledger structural instead of a
 * convention, so they are asserted over the SOURCE rather than over behaviour
 * (a behavioural test can only cover the paths someone remembered to write):
 *
 *   1. NO MODULE MINTS AN UNMETERED ADAPTER. `createAdapter()` — a connector's
 *      adapter factory — may be called from exactly one file, the registry that
 *      wraps its result in the metering proxy. Any other caller would hold a
 *      raw adapter and its spend would vanish.
 *   2. NO MODULE TALKS TO A PROVIDER'S INFERENCE API DIRECTLY, except the files
 *      registered below with a stated reason.
 *   3. THERE IS NO OPT-OUT. The metering seam exports no way to silence itself
 *      and no module hand-builds a `source:"llm"` usage event, so the seam is
 *      the single producer and double-counting is structurally impossible.
 *
 * KNOWN OPEN PATHS are registered too, with the issue that owns them, so this
 * file is an honest inventory rather than a claim of completeness. Graphiti's
 * per-episode OpenAI fan-out is uncounted and is DEFERRED pending the owner's
 * analysis — see cinatra#2582. It is recorded here, not fixed here.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "../..");

/** Runtime source trees. Test files and fixtures are excluded (see `isScanned`). */
const SCANNED_ROOTS = ["src", "packages"];

const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  "__tests__",
  "__mocks__",
  "__stubs__",
  "__helpers__",
  "tests",
  "dist",
  "build",
  ".next",
  "generated",
]);

const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

function isScanned(filePath: string): boolean {
  if (!SCANNED_EXTENSIONS.has(path.extname(filePath))) return false;
  const base = path.basename(filePath);
  return !base.includes(".test.") && !base.includes(".spec.");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (isScanned(full)) out.push(full);
  }
  return out;
}

const SOURCE_FILES: Array<{ rel: string; text: string }> = SCANNED_ROOTS.flatMap(
  (root) => walk(path.join(REPO_ROOT, root)),
).map((full) => ({
  rel: path.relative(REPO_ROOT, full).split(path.sep).join("/"),
  text: readFileSync(full, "utf8"),
}));

function filesMatching(pattern: RegExp): string[] {
  return SOURCE_FILES.filter((file) => pattern.test(file.text))
    .map((file) => file.rel)
    .sort();
}

// ---------------------------------------------------------------------------
// Registered exceptions — each carries the reason it is allowed to exist.
// ---------------------------------------------------------------------------

type Registered = { file: string; why: string; knownOpenIssue?: number };

/** The ONE file permitted to call a connector's adapter factory. */
const ADAPTER_MINT_POINT = "packages/llm/src/registry.ts";

/** Files permitted to reach a provider API without going through an adapter. */
const DIRECT_PROVIDER_CALLERS: Registered[] = [
  {
    file: "src/app/configuration/mcp/llm-access/test/route.ts",
    why:
      "Admin key-validation probe. Since the cinatra#2579 rewrite it runs NO " +
      "inference — a catalog read (connector surface preferred, bodyless models " +
      "fallback) that publishes its own usage event at its own seam.",
  },
  {
    file: "packages/llm/src/tools/anthropic-custom-skills-client.ts",
    why:
      "Anthropic Custom Skills MANAGEMENT API (skill CRUD / upload). No inference, " +
      "no tokens, nothing to meter.",
  },
];

/**
 * The ONLY modules that may PUBLISH a usage event onto the bus. Anything else
 * building a row by hand can (and did) hardcode `cachedInputTokens` /
 * `reasoningOutputTokens` to zero and misprice it.
 */
/**
 * The ONLY modules that may call the seam's `emitLlmUsage`. A caller that
 * invoked it AROUND an already-metered adapter call would double-count while
 * every other assertion here still passed, so the set is pinned by name.
 */
const EMIT_LLM_USAGE_CALLERS: Registered[] = [
  {
    file: "packages/llm/src/usage-metering.ts",
    why: "Defines it; the metering proxy is its primary caller.",
  },
  {
    file: "packages/llm/src/index.ts",
    why:
      "Batch outcome accounting. A batch's tokens arrive on the RESULT rows, not " +
      "from an adapter call, so no proxy invocation exists to meter.",
  },
];

const USAGE_EVENT_PUBLISHERS: Registered[] = [
  {
    file: "packages/metric-contracts/src/bus.ts",
    why: "Defines the bus emitter itself.",
  },
  {
    file: "packages/llm/src/usage-metering.ts",
    why: "The seam. The single producer of every source:\"llm\" row.",
  },
  {
    file: "src/app/configuration/mcp/llm-access/test/route.ts",
    why:
      "The cinatra#2579 validation rewrite: a catalog read with no adapter in " +
      "play publishes its one operation:\"validate\" row directly.",
  },
  {
    file: "src/lib/extension-host-context.ts",
    why:
      "Inverts the telemetry surface for EXTENSION-realm producers, which run " +
      "outside this repo and cannot reach the seam. It forwards their event " +
      "verbatim; it never builds one.",
  },
];

/**
 * Paths that reach a provider and are still NOT in the ledger. Recorded, not
 * hidden: each names the issue that owns it.
 */
const KNOWN_OPEN_PATHS: Registered[] = [
  {
    file: "packages/objects/src/graphiti-client.ts",
    why:
      "Graphiti runs in its own container on its own key and fans out many OpenAI " +
      "calls per episode (extraction, dedup, summaries, embeddings). None reach " +
      "usage_events. DEFERRED pending the owner's analysis — not touched by this change.",
    knownOpenIssue: 2582,
  },
];

const registeredFiles = (entries: Registered[]) =>
  entries.map((entry) => entry.file).sort();

describe("the adapter mint point is the only place an adapter is created", () => {
  it("only the registry calls a connector's createAdapter()", () => {
    // `resolveProviderAdapter` wraps what this returns in the metering proxy.
    // A second caller would hold a RAW adapter and its spend would not be counted.
    //
    // Matches an INVOCATION (`surface.createAdapter()`) or a destructuring that
    // detaches the factory (`const { createAdapter } = surface`) — not the ABI's
    // own member DECLARATION in the SDK contract, which is a type, not a call.
    // Covers a plain call, an optional call, bracket access with either quote
    // style, a destructuring, and a PROPERTY-ALIAS extraction
    // (`const factory = surface.createAdapter`) — detaching the factory reaches
    // the same raw adapter without ever writing `createAdapter(`. It does NOT
    // match the ABI's own member DECLARATION in the SDK contract, which is a
    // type, nor a `typeof x.createAdapter === "function"` presence probe.
    //
    // Text matching, not an AST: it is deliberately conservative and would miss
    // a computed name built at runtime. That is acceptable because the value it
    // protects is reviewability — a reader of a diff that reaches the factory
    // any of these ways sees this test go red.
    const INVOKES_ADAPTER_FACTORY =
      /\.\s*createAdapter\s*(\?\.)?\s*\(|\?\.\s*createAdapter\s*\(|\[\s*["'`]createAdapter["'`]\s*\]\s*\(|\{[^{}]*\bcreateAdapter\b[^{}]*\}\s*=|=\s*[\w.$]+\??\.\s*createAdapter\s*[;,\n]/;
    expect(filesMatching(INVOKES_ADAPTER_FACTORY)).toEqual([ADAPTER_MINT_POINT]);
  });

  it("the registry feeds the factory's result THROUGH the metering wrapper", () => {
    // Not merely "the name appears" — an unused import would satisfy that. The
    // returned value has to be the wrapped one.
    const registry = SOURCE_FILES.find((file) => file.rel === ADAPTER_MINT_POINT);
    expect(registry).toBeDefined();
    expect(registry!.text).toMatch(
      /return\s+meterLlmProviderAdapter\(\s*adapter\s+as\s+LlmProviderAdapter\s*\)/,
    );
  });
});

describe("no module reaches a provider inference API outside the seam", () => {
  it("direct provider-host callers are exactly the registered ones", () => {
    const PROVIDER_HOSTS =
      /https:\/\/api\.openai\.com|https:\/\/api\.anthropic\.com|https:\/\/generativelanguage\.googleapis\.com/;
    expect(filesMatching(PROVIDER_HOSTS)).toEqual(
      registeredFiles(DIRECT_PROVIDER_CALLERS),
    );
  });

  it("no module imports a provider SDK — a URL-only scan would miss that", () => {
    // `new OpenAI(...)` reaches the same billed endpoints without ever naming a
    // host, so the host scan above is not sufficient on its own. Provider SDKs
    // belong in the connectors, which live outside this repo.
    // Both quote styles, package SUBPATHS, static import / require / dynamic
    // `import()` — a single-quote or `openai/resources` import reaches the same
    // billed endpoints and must not slip past.
    const SDK = "(?:openai|@anthropic-ai/sdk|@google/genai)(?:/[\\w./-]+)?";
    const PROVIDER_SDK_IMPORT = new RegExp(
      `(?:from|import|require)\\s*\\(?\\s*["'\`]${SDK}["'\`]`,
    );
    expect(filesMatching(PROVIDER_SDK_IMPORT)).toEqual([]);
  });

  it("the admin probe registered above really does emit usage", () => {
    const probe = SOURCE_FILES.find(
      (file) => file.rel === "src/app/configuration/mcp/llm-access/test/route.ts",
    );
    expect(probe).toBeDefined();
    // The #2579 rewrite publishes exactly one usage event per validation, at
    // its own seam, through the bus emitter it imports directly.
    expect(probe!.text).toContain('import { emitUsageEvent } from "@cinatra-ai/metric-usage-api"');
    expect(probe!.text.match(/^\s*emitUsageEvent\(\{/gm) ?? []).toHaveLength(1);
    expect(probe!.text).not.toContain("emitLlmUsage");
  });

  it("every registered exception states a reason", () => {
    for (const entry of DIRECT_PROVIDER_CALLERS) {
      expect(entry.why.length).toBeGreaterThan(20);
    }
  });
});

describe("the seam has no bypass", () => {
  it("exports no way to silence metering", () => {
    // A name-level guard on purpose: the previous design carried a
    // `withCallerEmittedUsage` opt-out, and an opt-out is exactly the kind of
    // affordance that spreads one call site at a time until the ledger is a
    // convention again.
    expect(filesMatching(/withCallerEmittedUsage|usageEmittedByCaller/)).toEqual([]);
  });

  it("only the registered publishers put a usage event on the bus", () => {
    expect(filesMatching(/\bemitUsageEvent\s*\(/)).toEqual(
      registeredFiles(USAGE_EVENT_PUBLISHERS),
    );
  });

  it("only the registered callers reach the seam's emitter directly", () => {
    // Every one of these is a path with NO adapter call to meter. A new entry
    // that DOES have one would double-count against the proxy.
    expect(filesMatching(/\bemitLlmUsage\s*\(/)).toEqual(
      registeredFiles(EMIT_LLM_USAGE_CALLERS),
    );
  });

  it("the seam is the only publisher that CONSTRUCTS a source:\"llm\" row", () => {
    const seam = SOURCE_FILES.find(
      (file) => file.rel === "packages/llm/src/usage-metering.ts",
    );
    expect(seam).toBeDefined();
    expect(seam!.text).toMatch(/emitUsageEvent\(\{\s*\n\s*source: "llm"/);
    // The extension-realm forwarder passes an event through, never builds one.
    const forwarder = SOURCE_FILES.find(
      (file) => file.rel === "src/lib/extension-host-context.ts",
    );
    expect(forwarder!.text).not.toMatch(/source:\s*"llm"/);
  });

  it("the llm-bridge media branch publishes attribution instead of its own row", () => {
    const bridge = SOURCE_FILES.find(
      (file) => file.rel === "src/app/api/llm-bridge/route.ts",
    );
    expect(bridge).toBeDefined();
    expect(bridge!.text).toContain("withUsageAttribution");
    expect(bridge!.text).not.toContain("emitUsageEvent(");
  });
});

describe("known-open paths are recorded, not hidden", () => {
  it("names the issue that owns each still-uncounted path", () => {
    expect(KNOWN_OPEN_PATHS.length).toBeGreaterThan(0);
    for (const entry of KNOWN_OPEN_PATHS) {
      expect(
        entry.knownOpenIssue,
        `${entry.file} must name the issue that owns it`,
      ).toBeTypeOf("number");
      expect(entry.why.length).toBeGreaterThan(20);
    }
  });

  it("Graphiti's fan-out is registered as open against cinatra#2582", () => {
    const graphiti = KNOWN_OPEN_PATHS.find((entry) =>
      entry.file.includes("graphiti"),
    );
    expect(graphiti).toBeDefined();
    expect(graphiti!.knownOpenIssue).toBe(2582);
  });

  it("a known-open path is NOT silently counted as an allowed direct caller", () => {
    // If Graphiti's path is ever instrumented it must move OUT of this list
    // rather than accumulate in both — that move is the signal the gap closed.
    const openFiles = new Set(registeredFiles(KNOWN_OPEN_PATHS));
    for (const allowed of registeredFiles(DIRECT_PROVIDER_CALLERS)) {
      expect(openFiles.has(allowed)).toBe(false);
    }
  });
});
