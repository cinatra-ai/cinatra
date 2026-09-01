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
import { mkdtempSync, rmSync } from "node:fs";
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

import { GENERATED_ARTIFACT_RENDERERS } from "@/lib/generated/artifact-renderers";

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
const HAS_REAL_DB = DB_URL !== "" && !DB_URL.includes("unused:unused@");
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

    it("the deck kind: the store REFUSES the row, and the refusal is the type declaration, not the display", async () => {
      // The refusal is asserted by its CLOSED reason token, never by its sentence
      // (Codex convergence, this leg). `ObjectsTypeNotRegisteredError` carries
      // `reason` precisely so a caller branches on it, and its own comment says
      // the mid-write refusals — a MIME the type does not accept, a payload the
      // schema rejects — deliberately carry NO ownership reason. A message match
      // would have accepted one of those and called it an ownership answer.
      const refusal = await mint("@cinatra-ai/slide-deck:deck", "application/pdf", PDF).then(
        () => null,
        (err: unknown) => err,
      );
      expect(refusal).toBeInstanceOf(creationMod.ObjectsTypeNotRegisteredError);
      expect((refusal as InstanceType<typeof creationMod.ObjectsTypeNotRegisteredError>).reason).toBe(
        "no-installed-definer",
      );
      // Nothing owns the namespace the pack declares its type under, so no row of
      // that kind can exist anywhere — while the pack's display sits in the
      // generated map at the version the wave pinned, waiting for a row that the
      // declaration makes impossible.
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

// THE OTHER HALF OF THE SAME QUESTION — the classifier's trust road, measured at
// the same pins. The proof leg read the runtime's refusal ("not package-owned by
// the artifact pack") as meaning the road could never be satisfied for a pack
// whose matcher was extracted into its own package. That reading skips the arm
// the extraction wave added. This describe measures the arm directly.
//
// No database and no store: the road resolves off the installed tree, so this is
// the same question the running instance asks, asked of the same files.
describe("the extracted matcher packs' declared trust road resolves at these pins (#3091)", () => {
  const PAIRS = [
    ["@cinatra-ai/screenshot-artifact", "@cinatra-ai/screenshot-matcher-skill", "screenshot-matcher"],
    ["@cinatra-ai/slide-deck-artifact", "@cinatra-ai/slide-deck-matcher-skill", "slide-deck-matcher"],
  ] as const;

  // The resolver is reached at its own module, not through the skills barrel.
  // The barrel is a leaf-free entry that pulls most of the application graph in
  // behind it, and the unit tier substitutes it wholesale; either way the thing
  // under measurement would stop being the shipped function. The module named
  // here IS the one the classifier calls at runtime.
  const resolveEdge = async (consumer: string) =>
    (
      await import("../../../../../packages/skills/src/extension-skill-resolver")
    ).resolveDeclaredSkillEdgeForPackage(consumer, "matcher");

  it.each(PAIRS)(
    "%s declares a matcher edge that resolves to its sibling provider's one bundle",
    async (consumer, provider, slug) => {
      const resolved = await resolveEdge(consumer);
      expect(resolved).toMatchObject({
        packageName: provider,
        slug,
        skillId: provider + ":" + slug,
      });
    },
  );

  it.each(PAIRS)(
    "%s names the SAME skill id in its manifest that the edge resolves to",
    async (consumer, provider, slug) => {
      registerArtifactExtensionDir(
        path.resolve(REPO_ROOT, "extensions/cinatra-ai", consumer.split("/")[1]!),
      );
      const entry = matcherManifestRegistry.get(consumer);
      const resolved = await resolveEdge(consumer);
      // The runtime honours a catalog row only when BOTH halves agree with what
      // the edge resolved to. The declaration side of that agreement holds here,
      // so a refusal on a live instance is not the manifests being wrong.
      expect(entry?.matcherSkillIds).toContain(provider + ":" + slug);
      expect(resolved?.skillId).toBe(provider + ":" + slug);
      matcherManifestRegistry.removeByPackage(consumer);
    },
  );
});
