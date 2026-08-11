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
 * file is an honest inventory rather than a claim of completeness.
 *
 * cinatra#2582 moved Graphiti out of that inventory: the episode hand-over seam
 * now publishes one `source:"graphiti"` row per episode, so the fan-out is no
 * longer invisible. It is NOT priced — the pinned wrapper reports no token usage
 * and offers no usage surface to poll — so the path is registered in
 * COUNTED_BUT_UNPRICED against the issue that owns closing that gap. "Counted"
 * and "priced" are tracked separately here on purpose: collapsing them is how a
 * $0 row starts reading as "free".
 *
 * cinatra#2641 empties the uncounted inventory the same way. `generateImage()`
 * was the one response-producing adapter method the seam did not meter — billed
 * per image, invisible to `/analytics/llm`. It is metered at the seam now, and
 * it is PRICEABLE now: the ABI's image response may carry a per-image usage
 * count, the seam forwards it, and the subscriber prices it off a per-image rate
 * card. It stays in COUNTED_BUT_UNPRICED because the mechanism existing is not
 * the same as the dollars arriving — the PINNED Gemini connector does not report
 * image usage yet, so every image row production writes today is still unpriced.
 * The register describes what the ledger currently SAYS, never what it is
 * capable of saying.
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

type Registered = {
  file: string;
  why: string;
  knownOpenIssue?: number;
  /**
   * A source fragment the registered file must still contain.
   *
   * A registry entry is a CLAIM about code. Without this, a rename or a
   * deletion leaves the claim behind and the inventory keeps describing a file
   * that no longer does what it says — the same silent-drift failure this file
   * exists to prevent, one level up.
   */
  mustContain?: string;
  /**
   * An extension whose PINNED revision the entry's claim depends on
   * (cinatra#2641).
   *
   * The gap that needs this: an entry can be about code living in another repo,
   * which this file cannot read. "The pinned Gemini connector does not report
   * image usage yet" is true of one SHA and stops being true at another, and
   * nothing in this repo would notice the difference. Recording the SHA the
   * claim was written against — and asserting it against
   * `cinatra-dev-extensions.lock.json` — turns the pin advance into a RED TEST
   * that forces the entry to be re-read, instead of leaving a stale claim
   * standing. It does not prove what the connector does; it proves nobody
   * changed which connector we mean without revisiting this.
   */
  pinnedExtension?: { packageName: string; resolvedSha: string };
};

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
  {
    file: "packages/objects/src/graphiti-client.ts",
    why:
      "cinatra#2582: the episode hand-over seam. Graphiti's per-episode OpenAI " +
      "fan-out happens in another container with no adapter call here to meter, " +
      "so this module publishes one source:\"graphiti\" row per episode sent. It " +
      "never builds a source:\"llm\" row, so the seam's single-producer invariant " +
      "is untouched.",
  },
];

/**
 * Paths that reach a provider and are still NOT in the ledger. Recorded, not
 * hidden: each names the issue that owns it.
 *
 * EMPTY IS A LEGITIMATE STATE and does not mean "complete" — the honest
 * inventory of what the ledger still cannot say now lives in
 * {@link COUNTED_BUT_UNPRICED} as well.
 */
const KNOWN_OPEN_PATHS: Registered[] = [];

/**
 * Paths whose rows REACH `usage_events` but carry no dollars — counted, not
 * priced. Registered so "the row exists" is never mistaken for "the spend is
 * measured", with the issue that owns closing the gap.
 */
const COUNTED_BUT_UNPRICED: Registered[] = [
  {
    file: "packages/llm/src/usage-metering.ts",
    why:
      "cinatra#2641: `adapter.generateImage()` is billed PER IMAGE and books one " +
      "row per call at the seam, so the path is not invisible. It is now " +
      "PRICEABLE but not yet PRICED. The ABI carries an optional per-image usage " +
      "count, the seam forwards it, and the subscriber prices it off the " +
      "per-image rate card — but the PINNED gemini-connector does not report " +
      "that usage yet, so every image row written in production still lands with " +
      "cost_usd NULL. The entry closes when the connector reports and the " +
      "extension pin advances, not when this mechanism merges.",
    knownOpenIssue: 2641,
    mustContain: "generateImage",
    pinnedExtension: {
      packageName: "@cinatra-ai/gemini-connector",
      resolvedSha: "afa62b4bb875e46f71114f65fe2ad768eefb3320",
    },
  },
  {
    file: "packages/objects/src/graphiti-client.ts",
    why:
      "cinatra#2582 makes every episode hand-over countable, but the pinned " +
      "knowledge-graph-mcp wrapper reports NO token usage back and exposes no " +
      "usage surface to poll, so the row lands with cost_usd NULL (the " +
      "dashboard's own \"unknown cost\" counter). Real dollar attribution needs " +
      "a substrate that reports its provider usage — cinatra#2591 — which is " +
      "why the Graphiti line item of cinatra#2578 stays open.",
    knownOpenIssue: 2578,
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
    for (const entry of KNOWN_OPEN_PATHS) {
      expect(
        entry.knownOpenIssue,
        `${entry.file} must name the issue that owns it`,
      ).toBeTypeOf("number");
      expect(entry.why.length).toBeGreaterThan(20);
    }
  });

  it("every registered open path still exists and still does what it claims", () => {
    // An entry is a claim about code. A rename or a deletion would otherwise
    // leave the claim standing, and an inventory that describes a file which no
    // longer contains the call is worse than an empty one — it reads as
    // tracked while nothing is being tracked.
    for (const entry of KNOWN_OPEN_PATHS) {
      const source = SOURCE_FILES.find((file) => file.rel === entry.file);
      expect(source, `${entry.file} is registered but does not exist`).toBeDefined();
      if (entry.mustContain) {
        expect(
          source!.text,
          `${entry.file} no longer contains "${entry.mustContain}" — close the entry or repoint it`,
        ).toContain(entry.mustContain);
      }
    }
  });

  it("Graphiti's fan-out is COUNTED now, and its pricing gap is registered", () => {
    // cinatra#2582 moved this path out of the uncounted inventory: every
    // episode hand-over now publishes a usage event. What it could NOT close is
    // the price — the wrapper reports no tokens — so the path moves to the
    // counted-but-unpriced register rather than disappearing.
    expect(KNOWN_OPEN_PATHS.some((entry) => entry.file.includes("graphiti"))).toBe(false);

    const unpriced = COUNTED_BUT_UNPRICED.find((entry) => entry.file.includes("graphiti"));
    expect(unpriced).toBeDefined();
    expect(unpriced!.knownOpenIssue).toBe(2578);

    // …and it is a registered publisher, so the move is real and not just a
    // deleted line: the file must actually emit.
    expect(registeredFiles(USAGE_EVENT_PUBLISHERS)).toContain(
      "packages/objects/src/graphiti-client.ts",
    );
    const client = SOURCE_FILES.find(
      (file) => file.rel === "packages/objects/src/graphiti-client.ts",
    );
    expect(client).toBeDefined();
    expect(client!.text).toContain(
      'import { emitUsageEvent } from "@cinatra-ai/metric-contracts"',
    );
    expect(client!.text).toMatch(/emitUsageEvent\(\{\s*\n\s*source: "graphiti"/);
    // The single-producer invariant it must NOT break.
    expect(client!.text).not.toMatch(/source:\s*"llm"/);
  });

  it("image generation is COUNTED now, and its pricing gap is registered", () => {
    // cinatra#2641. `adapter.generateImage()` reached a provider, was billed per
    // image and booked NO row — the one response-producing adapter method the
    // seam did not meter. It is metered at the seam now, so its caller leaves
    // the uncounted inventory and the SEAM joins the counted-but-unpriced one:
    // the ABI's image response carries no usage, so there are no dollars to
    // state, only a call to count.
    //
    // These are SOURCE assertions on purpose — this file proves structure. That
    // the row is really written is proved behaviourally in
    // `packages/llm/src/usage-metering.test.ts` (the real proxy, a fake adapter)
    // and end to end in `src/__tests__/integration/usage-ledger-capture.
    // integration.test.ts` (a real `usage_events` table).
    expect(KNOWN_OPEN_PATHS.some((entry) => entry.file.includes("blog/gemini"))).toBe(
      false,
    );

    const unpriced = COUNTED_BUT_UNPRICED.find(
      (entry) => entry.file === "packages/llm/src/usage-metering.ts",
    );
    expect(unpriced).toBeDefined();
    expect(unpriced!.knownOpenIssue).toBe(2641);

    // The claim has to be true of the code: the seam meters the image method and
    // books it under its OWN operation, so image work stays separable from
    // interactive spend by query rather than only by reading a label. (Its token
    // columns are zeros, so token sums are unaffected; DOLLAR aggregates are a
    // different matter — `SUM(cost_usd)` skips NULLs, which is why the breakdown
    // rows carry an explicit unpriced count.)
    const seam = SOURCE_FILES.find(
      (file) => file.rel === "packages/llm/src/usage-metering.ts",
    );
    expect(seam).toBeDefined();
    expect(seam!.text).toMatch(/IMAGE_METHOD\s*=\s*"generateImage"/);
    expect(seam!.text).toMatch(/prop === IMAGE_METHOD/);
    expect(seam!.text).toMatch(/operation:\s*"image"/);

    // And the pricing layer must never run the per-TOKEN card over it. Zero
    // tokens through that card answers 0, and a stored 0 reads as "this image
    // was free". It routes to the PER-IMAGE card instead, which answers null
    // — the same unpriced row — whenever no count or no rate is available.
    const subscriber = SOURCE_FILES.find(
      (file) => file.rel === "packages/metric-cost-api/src/event-subscriber.ts",
    );
    expect(subscriber).toBeDefined();
    expect(subscriber!.text).toMatch(
      /operation === "image"\s*\n?\s*\?\s*computeImageCostUsd\(/,
    );
  });

  it("image generation is PRICEABLE now — the mechanism exists end to end", () => {
    // cinatra#2641's pricing half. Three source claims, one per layer, so a
    // future edit that removes any link in the chain is visible in a diff:
    //   1. the ABI lets an image response report a PER-IMAGE unit;
    //   2. the seam forwards what the adapter reported (and never defaults it);
    //   3. the subscriber has a per-image card with a rate to price against.
    //
    // Behaviour is proved elsewhere — `packages/llm/src/usage-metering.test.ts`
    // for the seam, `packages/metric-cost-api/tests/image-pricing.test.ts` for
    // the card, `.../tests/image-usage-row.test.ts` for the routing. This file
    // proves STRUCTURE.
    const abi = SOURCE_FILES.find(
      (file) =>
        file.rel === "packages/sdk-extensions/src/llm-provider-adapter-contract.ts",
    );
    expect(abi).toBeDefined();
    expect(abi!.text).toMatch(/export type LlmImageUsage = \{/);
    expect(abi!.text).toMatch(/images: number;/);
    expect(abi!.text).toMatch(/Promise<LlmImageResponse \| null>/);

    // The seam forwards only what the ADAPTER attested — never a count it
    // paired with the model the CALLER happened to request.
    const seam = SOURCE_FILES.find(
      (file) => file.rel === "packages/llm/src/usage-metering.ts",
    );
    expect(seam!.text).toMatch(/function readPriceableImageUsage\(/);
    expect(seam!.text).toMatch(/imageCount: priceable\?\.images/);
    // …and the prompt quantity travels on its OWN field, because the row's
    // `input_tokens` column is NOT NULL and cannot say "unreported".
    expect(seam!.text).toMatch(/imagePromptTokensReported: priceable\?\.promptTokens !== undefined/);
    const subscriberSource = SOURCE_FILES.find(
      (file) => file.rel === "packages/metric-cost-api/src/event-subscriber.ts",
    );
    expect(subscriberSource!.text).toMatch(/event\.imagePromptTokensReported\s*\n?\s*\? event\.inputTokens/);

    const card = SOURCE_FILES.find(
      (file) => file.rel === "packages/metric-cost-api/src/pricing/index.ts",
    );
    expect(card).toBeDefined();
    expect(card!.text).toMatch(/export function computeImageCostUsd\(/);
    // A rate card nobody can re-check is not evidence. Every entry names the
    // provider page it came from, the service tier it is quoted at, and the date
    // it was read.
    expect(card!.text).toMatch(/asOf: "\d{4}-\d{2}-\d{2}"/);
    expect(card!.text).toMatch(/source: "https:\/\//);
    expect(card!.text).toMatch(/tier: "/);
    // And the provider is part of the rate identity — a model NAME alone would
    // let any connector borrow another provider's rate by naming its model.
    expect(card!.text).toMatch(/provider: string \| null \| undefined/);
  });

  it("PRICEABLE is registered separately from PRICED — bound to the connector pin", () => {
    // The failure this guards: a mechanism merges, the register entry is closed
    // because "images can be priced now", and every row production actually
    // writes is still NULL. The pinned connector has to report first, and the
    // extension pin has to advance, before this entry can go.
    //
    // The entry's claim is about code in ANOTHER repo, which this file cannot
    // read — so it is bound to the SHA the claim was written against instead.
    // Advancing the pin turns this red and forces the entry to be re-read. That
    // is the honest guarantee available here: not "the connector still reports
    // nothing", but "nobody changed which connector we mean without revisiting
    // this".
    const unpriced = COUNTED_BUT_UNPRICED.find(
      (entry) => entry.file === "packages/llm/src/usage-metering.ts",
    );
    expect(unpriced).toBeDefined();
    expect(unpriced!.knownOpenIssue).toBe(2641);
    // The entry must say what is still missing, not merely that something is.
    expect(unpriced!.why).toMatch(/pin/i);

    const pin = unpriced!.pinnedExtension;
    expect(pin, "the entry must name the extension pin it depends on").toBeDefined();

    const lock = JSON.parse(
      readFileSync(path.join(REPO_ROOT, "cinatra-dev-extensions.lock.json"), "utf8"),
    ) as { packages?: Array<{ packageName: string; resolvedSha: string }> };
    const locked = (lock.packages ?? []).find(
      (entry) => entry.packageName === pin!.packageName,
    );
    expect(locked, `${pin!.packageName} must still be a pinned extension`).toBeDefined();
    expect(
      locked!.resolvedSha,
      `${pin!.packageName} moved to ${locked!.resolvedSha}. Re-read the ` +
        "counted-but-unpriced entry for the image seam: if that revision reports " +
        "image usage, image rows are PRICED now and the entry closes; if not, " +
        "repoint the entry at the new SHA.",
    ).toBe(pin!.resolvedSha);
  });

  it("every counted-but-unpriced path names the issue that owns its pricing gap", () => {
    for (const entry of COUNTED_BUT_UNPRICED) {
      expect(
        entry.knownOpenIssue,
        `${entry.file} must name the issue that owns its pricing gap`,
      ).toBeTypeOf("number");
      expect(entry.why.length).toBeGreaterThan(20);
    }
  });

  it("every counted-but-unpriced path still exists and still does what it claims", () => {
    // Same drift guard the uncounted inventory carries: an entry is a claim
    // about code, and a claim left standing over a renamed or deleted file
    // reads as tracked while nothing is tracked.
    for (const entry of COUNTED_BUT_UNPRICED) {
      const source = SOURCE_FILES.find((file) => file.rel === entry.file);
      expect(source, `${entry.file} is registered but does not exist`).toBeDefined();
      if (entry.mustContain) {
        expect(
          source!.text,
          `${entry.file} no longer contains "${entry.mustContain}" — close the entry or repoint it`,
        ).toContain(entry.mustContain);
      }
    }
  });

  it("a known-open path is NOT silently counted as an allowed direct caller", () => {
    // A path that gets instrumented must move OUT of this list rather than
    // accumulate in both — that move is the signal the gap closed.
    const openFiles = new Set(registeredFiles(KNOWN_OPEN_PATHS));
    for (const allowed of registeredFiles(DIRECT_PROVIDER_CALLERS)) {
      expect(openFiles.has(allowed)).toBe(false);
    }
  });
});
