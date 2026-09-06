// WHAT A REAL ROW OF THE KIND RESOLVES TO, READ BACK OUT OF A REAL STORE
// (cinatra#3091, wave 3 of #3087 — the trust-road diagnosis leg).
//
// The second proof leg could not create a screenshot-kind row or a deck-kind row
// on the running instance, and read that as the display half of the wave being
// unreachable. That reading mixes two questions. This suite separates them by
// MINTING the rows directly in a real store — bypassing the creation road the leg
// was blocked on — and then asking the artifact page's own resolver what it
// returns for the row it reads back.
//
// The separation matters because the two halves fail for different reasons and
// are owed to different places. Creation is blocked by the classifier trust road
// and by a type declaration; display is a property of the resolver and the
// generated map. A record that says the display is unreachable when only creation
// is blocked sends the next leg to the wrong repository.
//
// The sibling suite w3-display-reachability.test.ts asks the same question of the
// registries alone. This one asks it of a row a real Postgres accepted, that
// bytes were written to disk for, and that is read back by id — so the answer
// covers the write boundary, the persisted type and the persisted media type too.
//
// DB-gated: self-skips unless a real SUPABASE_DB_URL is provided.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";

import { registerArtifactExtensionDir } from "@cinatra-ai/objects/register-artifact-extensions";
import { matcherManifestRegistry, objectTypeRegistry } from "@cinatra-ai/objects/registry";
import {
  semanticRendererRegistry,
  representationProviderRegistry,
} from "@cinatra-ai/objects/artifact-renderer-registry";
import { resolveEffectiveIdentity } from "@cinatra-ai/objects/effective-identity";

import { parseFrontmatter } from "../../../../../packages/skills/src/agent-skill-paths";

import { GENERATED_ARTIFACT_RENDERERS } from "@/lib/generated/artifact-renderers";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

import { resolveArtifactDispatchInputs, _resetFirstPartySeedForTests } from "../renderer-resolution";
import { pickArtifactRenderer } from "../renderer-dispatch";

// The store modules are imported for real; only the boot-time side effects are
// stood down. `importOriginal` keeps every other export intact, because the page
// resolver this suite exercises pulls a much wider slice of the app in than a
// store-only suite does — a hand-listed mock would fail on the first export it
// did not think of, for a reason that is not the code's.
vi.mock("@/lib/database", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/database")>();
  const cfg = await import("@/lib/postgres-config");
  return {
    ...actual,
    readChatThreadForClassifier: () => null,
    readMetadataValueFromDatabase: (_key: string, fallback: unknown) => fallback,
    writeMetadataValueToDatabase: () => {},
    getPostgresConnectionString: cfg.getPostgresConnectionString,
    postgresSchema: cfg.postgresSchema,
    ensurePostgresSchema: () => {},
  };
});
vi.mock("@/lib/postgres-schema-init", () => ({ ensurePostgresSchema: () => {} }));
vi.mock("@/lib/register-all-object-types", () => ({ registerAllObjectTypes: () => {} }));

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..", "..");
const DB_URL = process.env.SUPABASE_DB_URL ?? "";
// "Is a real database there?" is asked through the ONE shared predicate, never
// inline. An inline substring test is wrong in both directions: it stops
// recognising the placeholder the moment its endpoint moves, and it reads a
// REAL database that happens to carry the reserved credential pair as the
// placeholder — skipping this tier while still reporting green.
const HAS_REAL_DB = DB_URL !== "" && !isPlaceholderDbUrl(DB_URL);
const TEST_SCHEMA = "cinatra_test_w3_kind_typed_row";
const ORG = "org-3091-kind-typed";

/** The packs whose kinds this suite mints rows of, read off disk at their pins. */
const PACKS = ["screenshot-artifact", "slide-deck-artifact", "pdf-artifact", "image-artifact"] as const;

/** A tiny but real PNG (1x1) so the blob store sees genuine image bytes. */
const PNG = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  ),
);

/** A real pdf, written byte by byte — the same shape the proof leg filed. */
const PDF = new TextEncoder().encode(
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n" +
    "2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n" +
    "3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n" +
    "trailer<</Root 1 0 R>>\n%%EOF\n",
);

async function* bytesOf(b: Uint8Array): AsyncIterable<Uint8Array> {
  yield b;
}

let creationMod: typeof import("@/lib/artifacts/artifact-creation");
let serviceMod: typeof import("@/lib/artifacts/artifact-service");
let readMod: typeof import("@/lib/artifacts/artifact-read");
let registrarMod: typeof import("@/lib/artifacts/system-artifact-renderer-registrar");
let runPostgresQueriesSync: typeof import("@/lib/postgres-sync").runPostgresQueriesSync;
let getPostgresConnectionString: typeof import("@/lib/postgres-config").getPostgresConnectionString;

function sql(text: string, values: unknown[] = []) {
  return runPostgresQueriesSync({
    connectionString: getPostgresConnectionString(),
    queries: [{ text, values }],
  })[0];
}

/** Read the row BACK OUT of the store by id — the object type and the media type
 *  the store actually persisted, never the values the test handed in. */
function readBackRow(artifactId: string): { objectType: string; mime: string } {
  const r = sql(
    `SELECT o.type AS t, res.mime AS m
       FROM "${TEST_SCHEMA}"."objects" o
       JOIN "${TEST_SCHEMA}"."representation" rep
         ON rep.artifact_id = o.id AND rep.org_id = o.org_id
       JOIN "${TEST_SCHEMA}"."resource" res
         ON res.id = rep.resource_id AND res.org_id = rep.org_id
      WHERE o.id = $1
      ORDER BY rep.revision DESC
      LIMIT 1`,
    [artifactId],
  );
  const row = r.rows?.[0] as { t: string; m: string } | undefined;
  if (!row) throw new Error("no representation row for " + artifactId);
  return { objectType: row.t, mime: row.m };
}

/** Mint a row of one kind DIRECTLY, bypassing the creation road entirely. */
async function mint(objectType: string, declaredMime: string, bytes: Uint8Array) {
  return creationMod.createSemanticArtifact({
    orgId: ORG,
    objectType,
    expectedAcceptMimes: [declaredMime],
    createdBy: null,
    ownerLevel: "organization",
    ownerId: ORG,
    title: "kind-typed row",
    declaredMime,
    originKind: "upload",
    stream: bytesOf(bytes),
    createdByRunId: null,
    skipFallbackClassification: true,
  });
}

/** THE PAGE'S OWN READ, not a re-derivation of it (Codex convergence, this leg).
 *  `page.tsx` does not compute the identity from the type and does not take "the
 *  numerically latest representation": it calls `readArtifactForDetail`, presents
 *  the assertion-aware PRESENTATION identity (which diverges from the effective
 *  identity BY DESIGN — a row filed as something else renders as that), and reads
 *  the representation its `latestRepresentationRevisionId` pointer names. Driving
 *  the seam with `resolveEffectiveIdentity(type)` and a `revision DESC` pick would
 *  have measured a road next to the page's, and would have gone on agreeing with
 *  itself if the page's identity ever moved. This helper calls the same functions
 *  page.tsx calls, in the same order, including the activation reconcile. */
async function pageDispatchForArtifact(artifactId: string) {
  const access = serviceMod.readArtifactForDetail({ artifactId, orgId: ORG });
  if (access.kind !== "ok") throw new Error("the detail read refused the row: " + access.kind);
  const artifact = access.artifact;
  const revisionId = artifact.latestRepresentationRevisionId;
  const resolved = revisionId
    ? readMod.resolveArtifactVersionForServe({
        orgId: ORG,
        artifactId,
        representationRevisionId: revisionId,
      })
    : null;
  const mime = resolved?.mime ?? artifact.mime ?? "";
  await registrarMod.ensureActivatedRepresentationProviders(ORG);
  return {
    objectType: artifact.objectType,
    mime,
    identity: artifact.presentationIdentity,
    dispatch: pickArtifactRenderer(
      resolveArtifactDispatchInputs({
        orgId: ORG,
        baseType: artifact.objectType,
        identity: artifact.presentationIdentity,
        mime,
      }),
    ),
  };
}

/** The same seam for a row that is NOT in the store — the floor rung, where the
 *  point is the type alone and there is nothing to read back. */
function dispatchForRow(row: { objectType: string; mime: string }) {
  return pickArtifactRenderer(
    resolveArtifactDispatchInputs({
      orgId: ORG,
      baseType: row.objectType,
      identity: resolveEffectiveIdentity(row.objectType),
      mime: row.mime,
    }),
  );
}

beforeAll(async () => {
  if (!HAS_REAL_DB) return;
  process.env.SUPABASE_SCHEMA = TEST_SCHEMA;
  process.env.CINATRA_ARTIFACT_DATA_ROOT = mkdtempSync(path.join(tmpdir(), "cin-3091-"));

  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
  await client.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
  const { buildCreateStoreSchemaQueries } = await import("@/lib/drizzle-store");
  for (const qy of buildCreateStoreSchemaQueries(TEST_SCHEMA)) {
    const head = qy.text.trim().slice(0, 6).toUpperCase();
    if (head !== "CREATE" && head !== "ALTER " && head !== "DROP T" && head !== "DROP S") continue;
    if (qy.text.includes("user_slug_move_trg")) continue;
    try {
      await client.query(qy.text, (qy as { values?: unknown[] }).values as never[]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes("does not exist") && !msg.includes("already exists")) throw err;
    }
  }
  await client.end();
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized = true;

  ({ runPostgresQueriesSync } = await import("@/lib/postgres-sync"));
  ({ getPostgresConnectionString } = await import("@/lib/postgres-config"));
  creationMod = await import("@/lib/artifacts/artifact-creation");
  serviceMod = await import("@/lib/artifacts/artifact-service");
  readMod = await import("@/lib/artifacts/artifact-read");
  registrarMod = await import("@/lib/artifacts/system-artifact-renderer-registrar");

  // The REAL pinned packs, read off disk exactly as the boot registrar reads
  // them — never a hand-written stand-in, so what is measured is what ships.
  objectTypeRegistry._clearForTests();
  for (const slug of PACKS) {
    registerArtifactExtensionDir(path.resolve(REPO_ROOT, "extensions/cinatra-ai", slug));
  }
}, 120_000);

afterAll(async () => {
  if (!HAS_REAL_DB) return;
  for (const slug of PACKS) {
    objectTypeRegistry.removeByPackage("@cinatra-ai/" + slug);
    semanticRendererRegistry.removeByPackage("@cinatra-ai/" + slug);
    matcherManifestRegistry.removeByPackage("@cinatra-ai/" + slug);
  }
  representationProviderRegistry._clearForTests(true);
  _resetFirstPartySeedForTests();
  const root = process.env.CINATRA_ARTIFACT_DATA_ROOT;
  if (root) rmSync(root, { recursive: true, force: true });
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
  await client.end();
}, 60_000);

describe.skipIf(!HAS_REAL_DB)(
  "a row that really carries the kind resolves to the kind's own display (#3091)",
  () => {
    it("the screenshot kind: the store accepts the row and the page reaches the pack's own detail entry", async () => {
      const created = await mint("@cinatra-ai/screenshot-artifact:screenshot", "image/png", PNG);
      // What Postgres actually kept, read straight out of the tables.
      const row = readBackRow(created.artifactId);
      expect(row.objectType).toBe("@cinatra-ai/screenshot-artifact:screenshot");
      expect(row.mime).toBe("image/png");
      // What the PAGE then makes of that row, through the page's own read.
      const page = await pageDispatchForArtifact(created.artifactId);
      expect(page.objectType).toBe("@cinatra-ai/screenshot-artifact:screenshot");
      expect(page.mime).toBe("image/png");
      expect(page.identity).toMatchObject({
        kind: "extension",
        extension: "@cinatra-ai/screenshot-artifact",
      });
      expect(page.dispatch).toEqual({
        kind: "semantic",
        packageName: "@cinatra-ai/screenshot-artifact",
        generatedKey: "@cinatra-ai/screenshot-artifact::detail",
      });
      expect(
        GENERATED_ARTIFACT_RENDERERS["@cinatra-ai/screenshot-artifact::detail"]?.propsApiVersion,
      ).toBe(2);
    });

    it("a type under a namespace no installed package owns is STILL refused — the registrar's namespace rule is not relaxed by the re-pin", async () => {
      // This was the deck pack's own declaration before its repository renamed
      // the type, and it is kept here as the NEGATIVE half of that fix. The
      // pack now self-names (the rung below mints a row of the new type), but
      // the rule that made the old declaration unmintable is a property of this
      // repository's registry, not of any pack, and it must go on holding for
      // every foreign namespace — otherwise the re-pin would have "fixed" the
      // symptom by loosening the thing that made the type's owner knowable.
      //
      // The refusal is asserted by its CLOSED reason token, never by its sentence
      // (the convergence round on the previous leg). `ObjectsTypeNotRegisteredError`
      // carries `reason` precisely so a caller branches on it, and its own comment
      // says the mid-write refusals — a MIME the type does not accept, a payload
      // the schema rejects — deliberately carry NO ownership reason. A message
      // match would have accepted one of those and called it an ownership answer.
      const refusal = await mint("@cinatra-ai/slide-deck:deck", "application/pdf", PDF).then(
        () => null,
        (err: unknown) => err,
      );
      expect(refusal).toBeInstanceOf(creationMod.ObjectsTypeNotRegisteredError);
      expect((refusal as InstanceType<typeof creationMod.ObjectsTypeNotRegisteredError>).reason).toBe(
        "no-installed-definer",
      );
      expect(objectTypeRegistry.getRegisteringPackage("@cinatra-ai/slide-deck:deck")).toBeNull();
      expect(
        GENERATED_ARTIFACT_RENDERERS["@cinatra-ai/slide-deck-artifact::detail"]?.propsApiVersion,
      ).toBe(2);
    });

    it("a pdf row typed by its own pack reaches that pack's display — the media type alone never decides", async () => {
      const created = await mint("@cinatra-ai/pdf-artifact:document", "application/pdf", PDF);
      const row = readBackRow(created.artifactId);
      expect(row.objectType).toBe("@cinatra-ai/pdf-artifact:document");
      const page = await pageDispatchForArtifact(created.artifactId);
      expect(page.mime).toBe("application/pdf");
      expect(page.dispatch).toEqual({
        kind: "semantic",
        packageName: "@cinatra-ai/pdf-artifact",
        generatedKey: "@cinatra-ai/pdf-artifact::detail",
      });
    });

    it("the same bytes under a type no pack defines fall to the host floor — the reading both proof legs share", () => {
      // The generic base type has no defining extension, so identity is no-primary
      // and the semantic arm resolves to nothing; the page draws the host's own
      // card for the media type. That is the contract, not a defect: it is what a
      // row carrying no kind is supposed to get.
      const row = { objectType: "@cinatra-ai/artifact:object", mime: "application/pdf" };
      expect(resolveEffectiveIdentity(row.objectType)).toEqual({ kind: "no-primary" });
      expect(dispatchForRow(row)).not.toMatchObject({ kind: "semantic" });
    });
  },
);

// ---------------------------------------------------------------------------
// THE CREATION ROAD, RE-MEASURED AT THE RE-PINNED HEADS (cinatra#3091, W3).
//
// The diagnosis leg left creation blocked for both kinds, for two DIFFERENT
// reasons, and both were owed to the packs' own repositories, not to this one:
//
//   - the deck kind could not be minted at all, because the pack declared its
//     object type under a namespace no installed package owns, so the registrar
//     registered the type for nobody;
//   - the screenshot kind could be minted directly, but the classifier that
//     mints it in production could not honour the pack's matcher skill, because
//     that skill was owned by a SIBLING package and neither trust anchor holds
//     for a sibling — the package-owned anchor because the owner is not the
//     artifact package, the declared-edge anchor because a manifest-declared
//     sibling is not a resolved provider edge.
//
// Both were fixed in the packs' own repositories and re-pinned here. NOTHING in
// this repository was relaxed to make these rungs pass: the namespace rule, the
// exclusivity of the two anchors, and the shadow rule are byte-unchanged, and
// the rungs below call the shipped functions rather than re-deriving them.
//
// What these rungs do NOT claim: the classifier's LLM call itself is not
// exercised (it needs a provider credential this tier has none of, and must
// never have). What is measured is the road up to and including the trust
// decision the leg was refused at, plus the store write on the other side of it.
// ---------------------------------------------------------------------------
describe.skipIf(!HAS_REAL_DB)("kind-typed creation at the re-pinned heads (#3091)", () => {
  it("the deck kind: the store now MINTS a row of the pack's SELF-NAMESPACED type, and the page reaches the deck pack's own detail entry", async () => {
    // The registrar now has an owner for the type, which is the whole content
    // of the pack-side fix — read off the registry rather than inferred from
    // the mint succeeding, so a mint that succeeded for some other reason
    // could not be reported as an ownership answer.
    expect(objectTypeRegistry.getRegisteringPackage("@cinatra-ai/slide-deck-artifact:deck")).toBe(
      "@cinatra-ai/slide-deck-artifact",
    );

    const created = await mint("@cinatra-ai/slide-deck-artifact:deck", "application/pdf", PDF);
    // What Postgres actually kept, read straight out of the tables.
    const row = readBackRow(created.artifactId);
    expect(row.objectType).toBe("@cinatra-ai/slide-deck-artifact:deck");
    expect(row.mime).toBe("application/pdf");

    // And what the PAGE makes of that row, through the page's own read.
    const page = await pageDispatchForArtifact(created.artifactId);
    expect(page.objectType).toBe("@cinatra-ai/slide-deck-artifact:deck");
    expect(page.mime).toBe("application/pdf");
    expect(page.identity).toMatchObject({
      kind: "extension",
      extension: "@cinatra-ai/slide-deck-artifact",
    });
    expect(page.dispatch).toEqual({
      kind: "semantic",
      packageName: "@cinatra-ai/slide-deck-artifact",
      generatedKey: "@cinatra-ai/slide-deck-artifact::detail",
    });
  });

  it("the screenshot kind: the classifier's trust road holds on the PACKAGE-OWNED arm, with the bundle inside the pack that owns it", async () => {
    const PKG = "@cinatra-ai/screenshot-artifact";
    const PKG_DIR = path.resolve(REPO_ROOT, "extensions/cinatra-ai/screenshot-artifact");
    registerArtifactExtensionDir(PKG_DIR);

    // 1) What the pack's manifest names as its matcher, read off the pinned
    //    tree through the same registry the bridge fills at boot.
    const matcherSkillId = matcherManifestRegistry.get(PKG)?.matcherSkillIds[0] ?? "";
    expect(matcherSkillId).toBe(PKG + ":screenshot-matcher");

    // 2) The bundle really SHIPS inside the pack that owns it. This is the half
    //    a sibling package can never give, and the half the anchor is about.
    const bundle = path.join(PKG_DIR, "skills", "screenshot-matcher", "SKILL.md");
    expect(existsSync(bundle)).toBe(true);
    const bundleText = readFileSync(bundle, "utf8");
    // A bundle with an empty body is skipped by the runtime one check further
    // on, so an existing-but-empty file would be a green rung over a road that
    // still does not run.
    expect(parseFrontmatter(bundleText).body.trim().length).toBeGreaterThan(0);

    // 3) WHICH ARM the runtime takes, and WHY the other one is empty. The two
    //    anchors are exclusive, so this single fact decides the trust question;
    //    it is asserted with the named reason token rather than a bare null,
    //    because a bare null is exactly what the proof leg could not read.
    const { resolveDeclaredSkillEdgeForPackageWithReason } = await import(
      "../../../../../packages/skills/src/extension-skill-resolver"
    );
    const outcome = await resolveDeclaredSkillEdgeForPackageWithReason(PKG, "matcher");
    expect(outcome.resolution).toBeNull();
    expect(outcome.reason).toBe("no-single-declared-edge-for-role");

    // 4) The runtime's OWN trust predicates — the shipped functions, called
    //    with the real ids and the real bundle — on the catalog row a
    //    co-located registration produces for that bundle. Package-owned trust
    //    holds; the declared-edge arm correctly confers nothing on an empty
    //    resolution. Neither anchor is widened anywhere in this delta.
    const { __test } = await import("@/lib/artifacts/matcher-runtime");
    const catalogRow = {
      id: matcherSkillId,
      packageName: PKG,
      packageSlug: "screenshot-artifact",
      content: bundleText,
    };
    expect(__test.skillPackageOwned(catalogRow, matcherSkillId, PKG)).toBe(true);
    expect(__test.skillMatchesResolvedEdge(catalogRow, matcherSkillId, outcome.resolution)).toBe(
      false,
    );
  });
});

// THE OTHER HALF OF THE SAME QUESTION — the classifier's trust road, measured at
// the same pins. The previous leg asked whether each pack's declared edge
// resolves, and read a single shape onto both packs. At these pins that is the
// wrong question: the two anchors are EXCLUSIVE, so what decides the trust road
// is WHICH ARM a pack takes, and the two packs now take different ones. That is
// the shape the extraction wave always intended — a pack that owns its bundle
// takes the package-owned anchor, a pack whose bundle lives in a provider
// package takes the declared edge — and this describe pins one pack to each.
//
// DB-GATED like the rest of the file, and the earlier claim that this describe
// needed no database was WRONG. The resolution walks the installed tree, but the
// retirement filter it goes through reads lifecycle status out of Postgres, and
// this tier's config pins SUPABASE_SCHEMA to the throwaway schema that the
// file-level `beforeAll` only builds when a real DSN is present. Left ungated, a
// run without the DSN did not skip - it FAILED on a missing relation, which is a
// false red about the ENVIRONMENT wearing the face of a trust-road regression.
// Measured both ways: without the DSN these two rungs failed with
// `relation "cinatra_test_w3_kind_typed_row.metadata" does not exist`; with it,
// the tier is 8 of 8. The file header promises this suite self-skips without a
// DSN, and with the gate it does.
describe.skipIf(!HAS_REAL_DB)("which matcher trust arm each pack takes, at these pins (#3091)", () => {
  // The resolver is reached at its own module, not through the skills barrel.
  // The barrel is a leaf-free entry that pulls most of the application graph in
  // behind it, and the unit tier substitutes it wholesale; either way the thing
  // under measurement would stop being the shipped function. The module named
  // here IS the one the classifier calls at runtime.
  const resolveEdge = async (consumer: string) =>
    (
      await import("../../../../../packages/skills/src/extension-skill-resolver")
    ).resolveDeclaredSkillEdgeForPackageWithReason(consumer, "matcher");

  it("the screenshot pack takes the PACKAGE-OWNED arm: it declares no matcher edge, and the id it names is its own", async () => {
    const consumer = "@cinatra-ai/screenshot-artifact";
    const outcome = await resolveEdge(consumer);
    expect(outcome.resolution).toBeNull();
    expect(outcome.reason).toBe("no-single-declared-edge-for-role");
    registerArtifactExtensionDir(
      path.resolve(REPO_ROOT, "extensions/cinatra-ai", consumer.split("/")[1]!),
    );
    // Self-namespaced, which is what the package-owned anchor requires of the
    // ID half as well as of the catalog row's owner.
    expect(matcherManifestRegistry.get(consumer)?.matcherSkillIds).toContain(
      consumer + ":screenshot-matcher",
    );
  });

  it("the deck pack takes the DECLARED-EDGE arm: the edge resolves to its provider's one bundle, and the manifest names that same id", async () => {
    const consumer = "@cinatra-ai/slide-deck-artifact";
    const provider = "@cinatra-ai/slide-deck-matcher-skill";
    const slug = "slide-deck-matcher";
    const outcome = await resolveEdge(consumer);
    expect(outcome.reason).toBeNull();
    expect(outcome.resolution).toMatchObject({
      packageName: provider,
      slug,
      skillId: provider + ":" + slug,
    });
    registerArtifactExtensionDir(
      path.resolve(REPO_ROOT, "extensions/cinatra-ai", consumer.split("/")[1]!),
    );
    // The runtime honours a catalog row only when BOTH halves agree with what
    // the edge resolved to. The declaration side of that agreement holds here.
    expect(matcherManifestRegistry.get(consumer)?.matcherSkillIds).toContain(
      provider + ":" + slug,
    );
  });
});
