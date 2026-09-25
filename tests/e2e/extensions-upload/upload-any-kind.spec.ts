/**
 * THE BROWSER WALK PER ROAD (cinatra#3204 criterion 34; cells CELL1 to CELL5 of
 * the round's own matrix).
 *
 * What it drives, in a real browser against a real server:
 *
 *   FILE ROAD — an archive of each live kind is supplied; the screen shows the
 *   kind it RESOLVED from the package, and mounts the STORE's own install panel
 *   (asserted by the store's own stable testids, not by a look-alike), whose
 *   picker is preselected to `Workspace: All` and whose action row is
 *   Cancel / Install now, with no popup anywhere on the page.
 *
 *   THE REFUSAL — an archive declaring the retired `workflow` kind is refused by
 *   name through the app's toast surface, the panel never appears, and nothing
 *   is written.
 *
 *   GITHUB ROAD — the tab asks for a LINK and nothing else: no connection is
 *   required, nothing is gated, and Submit goes live the moment a link is typed;
 *   and a link resolves to ONE immutable commit which is displayed, beside the
 *   archive it was downloaded from, the resolved kind and the same install panel.
 *
 *   THE COMPLETED INSTALL — an agent, a skill, an artifact and a connector
 *   package are installed through the screen at a chosen scope and then OBSERVED
 *   on the surface that kind lives on. A connector that declares NO access scope
 *   is refused by name, with the panel unchanged and the refusal readable on the
 *   toast surface: that refusal is the kind's own contract seen from the screen,
 *   not a gap in the walk.
 *
 * Both palettes are walked: the page is rendered once in light and once in dark,
 * and the assertions are made in each.
 */
import { test, expect, type Locator, type Page } from "@playwright/test";
import { deflateRawSync } from "node:zlib";

const SHOT_DIR = process.env.E2E_UPLOAD_SHOT_DIR ?? null;

// ---------------------------------------------------------------------------
// A minimal STORED-method ZIP writer. The upload form reads a real archive, so
// the walk supplies a real archive rather than stubbing the reader.
// ---------------------------------------------------------------------------
function crcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
}
const CRC = crcTable();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
void deflateRawSync;

function storedZip(files: { name: string; content: string }[]): Buffer {
  const enc = new TextEncoder();
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const nameBytes = enc.encode(file.name);
    const data = enc.encode(file.content);
    const crc = crc32(data);
    const lh = Buffer.alloc(30 + nameBytes.length);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0, 6);
    lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(0, 10);
    lh.writeUInt16LE(0, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBytes.length, 26);
    lh.writeUInt16LE(0, 28);
    Buffer.from(nameBytes).copy(lh, 30);
    local.push(lh, Buffer.from(data));

    const ch = Buffer.alloc(46 + nameBytes.length);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0, 8);
    ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(0, 12);
    ch.writeUInt16LE(0, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBytes.length, 28);
    ch.writeUInt16LE(0, 30);
    ch.writeUInt16LE(0, 32);
    ch.writeUInt16LE(0, 34);
    ch.writeUInt16LE(0, 36);
    ch.writeUInt32LE(0, 38);
    ch.writeUInt32LE(offset, 42);
    Buffer.from(nameBytes).copy(ch, 46);
    central.push(ch);
    offset += lh.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...local, centralBuf, eocd]);
}

// A REAL agent flow document. `cinatra/oas.json` is compiled at install by the
// agent handler and must satisfy the OAS 26.1.0 structural contract — a name
// and a version alone are refused, so a three-field stub would measure that
// refusal instead of the install this cell is named for. Start -> End with one
// echoed string is the smallest document that passes.
const FLOW_INPUT = {
  title: "note",
  type: "string",
  description: "The note the walk hands the flow.",
};
const OAS = JSON.stringify({
  agentspec_version: "26.1.0",
  component_type: "Flow",
  id: "upload-walk-agent-flow",
  name: "Upload Walk Agent",
  description: "A deterministic flow supplied by the upload walk.",
  // The flow declares a human-in-the-loop screen of its own, because that is
  // what CELL4's agent cell is named for: `/agents` is the RUN picker and it
  // carries the installed templates that declare such a step (plus their
  // sub-agents and external A2A agents). A flow with no gate is installed just
  // as completely and is simply not on that page — through this road and
  // through the store road alike — so a fixture without one would measure the
  // page's run-visibility rule instead of the install this cell is about.
  metadata: { cinatra: { type: "leaf", hitlScreens: ["review"] } },
  inputs: [FLOW_INPUT],
  outputs: [FLOW_INPUT],
  start_node: { $component_ref: "upload-walk-start" },
  nodes: [{ $component_ref: "upload-walk-start" }, { $component_ref: "upload-walk-end" }],
  control_flow_connections: [
    {
      component_type: "ControlFlowEdge",
      id: "upload-walk-start->end",
      name: "start->end",
      from_node: { $component_ref: "upload-walk-start" },
      to_node: { $component_ref: "upload-walk-end" },
    },
  ],
  data_flow_connections: [
    {
      component_type: "DataFlowEdge",
      id: "upload-walk-note:start->end",
      name: "note:start->end",
      source_node: { $component_ref: "upload-walk-start" },
      source_output: "note",
      destination_node: { $component_ref: "upload-walk-end" },
      destination_input: "note",
    },
  ],
  $referenced_components: {
    "upload-walk-start": {
      component_type: "StartNode",
      id: "upload-walk-start",
      name: "start",
      inputs: [FLOW_INPUT],
      outputs: [FLOW_INPUT],
      branches: ["next"],
    },
    "upload-walk-end": {
      component_type: "EndNode",
      id: "upload-walk-end",
      name: "end",
      inputs: [FLOW_INPUT],
      outputs: [FLOW_INPUT],
      branches: [],
      branch_name: "next",
    },
  },
});

// A per-RUN package name. CELL4 measures "a package installs and is then
// visible where that kind lives"; re-supplying the same name on a boot that
// already holds a row for it measures a RE-install over an existing row
// instead, and an earlier run's archived row makes that a different question
// with a different answer. One suffix per run keeps every run's cell the
// question the cell is named for.
const RUN_TAG = process.env.E2E_UPLOAD_RUN_TAG ?? Date.now().toString(36);

// The KIND-AT-END naming convention the product enforces on every road: a
// package of a kind is named `@<vendor>/<slug>-<kind>` (the skill packaging
// verdict and the artifact validator both refuse anything else), so the run
// tag belongs in the slug, never after the kind.
function packageName(
  kind: "agent" | "skill" | "connector" | "artifact",
  tag: string = RUN_TAG,
): string {
  return `@acme/upload-walk-${tag}-${kind}`;
}

// THE WALK'S OWN SKILL, NAMED. The catalog stores a skill's name as the
// frontmatter name split on hyphens and title-cased, so the name a card offers
// is derived here exactly as the catalog derives it rather than guessed.
function walkSkillSlug(tag: string): string {
  return `upload-walk-${tag}-note`;
}

function walkSkillCatalogName(tag: string): string {
  return walkSkillSlug(tag)
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function packageZip(
  kind: "agent" | "skill" | "connector" | "artifact",
  tag: string = RUN_TAG,
): Buffer {
  const manifest: Record<string, unknown> = {
    name: packageName(kind, tag),
    version: "1.0.0",
    cinatra: { kind } as Record<string, unknown>,
  };
  const files: { name: string; content: string }[] = [];
  if (kind === "agent") {
    // A REAL agent package: the install path validates every member against the
    // fail-closed agent metadata contract, so a manifest carrying the kind alone
    // measures that refusal rather than the install this cell is named for.
    Object.assign(manifest.cinatra as Record<string, unknown>, {
      packageType: "agent",
      manifestVersion: 1,
      sourceTemplateId: "upload-walk-template",
      sourceVersionId: "upload-walk-version",
      sourceVersionNumber: 1,
      riskLevel: "low",
      hasApprovalGates: false,
      toolAccess: [],
      ownerOrgId: null,
    });
    files.push({ name: "cinatra/oas.json", content: OAS });
  }
  if (kind === "skill")
    // A REAL skill package: the packaging contract the product enforces on
    // every road requires a description in the frontmatter, and a fixture that
    // omits it measures the refusal rather than the install.
    //
    // The skill's own SLUG carries the run tag. A cell that reads the skill by
    // the name the package gives it needs a name no other package on the
    // instance carries, and `one` is a word half the catalog could hold.
    files.push({
      name: `skills/${walkSkillSlug(tag)}/SKILL.md`,
      content: `---\nname: ${walkSkillSlug(
        tag,
      )}\ndescription: A skill supplied by the upload walk.\n---\nbody`,
    });
  if (kind === "connector") {
    // A connector declares its access scope in `cinatra/config.json`, and the
    // product refuses one that declares nothing at every surface. This is the
    // conforming package — the one the issue's headline is about.
    (manifest.cinatra as Record<string, unknown>).serverEntry = "dist/server.js";
    // The kind's observable is the schema-config connector's configuration
    // surface, so the fixture IS a schema-config connector: it declares its
    // setup surface as DATA and the host renders it from its own sdk-ui. A
    // connector that declares no surface can only ever reach the route's
    // requires-rebuild state, which is not the surface the cell is named for.
    (manifest.cinatra as Record<string, unknown>).uiSurface = "schema-config";
    (manifest.cinatra as Record<string, unknown>).configSchema = {
      title: "Upload walk connector",
      description: "Supplied by the upload walk.",
      fields: [{ kind: "text", key: "endpoint", label: "Endpoint" }],
    };
    files.push({ name: "dist/server.js", content: "export function register() {}" });
    files.push({
      name: "cinatra/config.json",
      content: JSON.stringify({ formatVersion: 1, access: { scope: { default: "admin" } } }),
    });
  }
  if (kind === "artifact") {
    // The artifact validator reads the descriptor off package.json (a sidecar
    // file alone is not the contract) and `accepts` is a REPRESENTATION-FORM
    // object, not a bare mime list — a list is refused before anything is
    // written, which is a refusal this cell is not about.
    const accepts = { file: { mimeTypes: ["text/plain"] } };
    // The pack must also DECLARE the object type it owns. Umbrella/derived-type
    // minting is retired, so a manifest that declares none registers no type at
    // all — and the installed list is built from each kind's own native
    // descriptors, so a type-less artifact pack installs and is then visible
    // nowhere. The claim is self-namespaced (the pack owns the type), which is
    // why it ships no inline schema: the registrar falls back to a permissive
    // one for a type its own declarer registers.
    const objectTypes = [
      { type: `${packageName("artifact", tag)}:note`, claim: "dedicated" },
    ];
    (manifest.cinatra as Record<string, unknown>).artifact = { accepts, objectTypes };
    files.push({
      name: "cinatra/artifact.json",
      content: JSON.stringify({ accepts, objectTypes }),
    });
  }
  return storedZip([
    { name: "package.json", content: JSON.stringify(manifest) },
    ...files,
  ]);
}

// THE CONNECTOR THAT DECLARES NOTHING. Same kind, same shape, one file short —
// the package the refusal cell is named for. It carries its own name so it never
// meets the row the install cell wrote, and the name still ends in the kind, as
// the product requires on every road.
const UNDECLARED_CONNECTOR_NAME = `@acme/upload-walk-${RUN_TAG}-undeclared-connector`;

function undeclaredConnectorZip(): Buffer {
  return storedZip([
    {
      name: "package.json",
      content: JSON.stringify({
        name: UNDECLARED_CONNECTOR_NAME,
        version: "1.0.0",
        cinatra: { kind: "connector", serverEntry: "dist/server.js" },
      }),
    },
    { name: "dist/server.js", content: "export function register() {}" },
  ]);
}

const RETIRED_ZIP = storedZip([
  {
    name: "package.json",
    content: JSON.stringify({
      name: "@acme/upload-walk-retired",
      version: "1.0.0",
      cinatra: { kind: "workflow" },
    }),
  },
]);

const PALETTES = ["light", "dark"] as const;

async function applyPalette(page: Page, palette: (typeof PALETTES)[number]): Promise<void> {
  await page.emulateMedia({ colorScheme: palette });
  await page.evaluate((mode) => {
    document.documentElement.classList.toggle("dark", mode === "dark");
    document.documentElement.setAttribute("data-theme", mode);
  }, palette);
}

async function shot(page: Page, name: string): Promise<void> {
  if (!SHOT_DIR) return;
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png`, fullPage: true });
}

async function openUpload(page: Page, palette: (typeof PALETTES)[number]): Promise<void> {
  await page.goto("/configuration/extensions/upload");
  await applyPalette(page, palette);
  await expect(page.getByRole("heading", { name: "Upload Extension" })).toBeVisible();
}

/**
 * THE TOAST SURFACE, MEASURED.
 *
 * "Errors are a toast" is only kept if the toast can be READ, and a toast is
 * read only where it is drawn: a message long enough to grow the toast past the
 * top of the window reports nothing at all, however correct its words. So this
 * reads the refusal's own words off the toast's title slot and MEASURES the
 * toast's box against the window rather than asserting it is visible — a node
 * whose box starts above y=0 is still "visible" to a DOM query.
 */
async function readToastSurface(
  page: Page,
): Promise<{ text: string; insideViewport: boolean; geometry: string }> {
  const toast = page.locator("[data-sonner-toast]").first();
  await expect(toast).toBeVisible({ timeout: 60_000 });
  const text = (await toast.locator("[data-title]").first().innerText())
    .replace(/\s+/g, " ")
    .trim();
  // The toast surface animates a toast IN from above its resting place, so a box
  // read the instant it becomes visible is the entrance transform, not where the
  // admin reads it. Poll until two consecutive reads agree, then measure THAT.
  let box = await toast.boundingBox();
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(100);
    const next = await toast.boundingBox();
    if (
      next !== null &&
      box !== null &&
      Math.abs(next.y - box.y) < 0.5 &&
      Math.abs(next.height - box.height) < 0.5
    ) {
      box = next;
      break;
    }
    box = next;
  }
  const viewport = page.viewportSize();
  const insideViewport =
    box !== null &&
    viewport !== null &&
    box.x >= 0 &&
    box.y >= 0 &&
    box.x + box.width <= viewport.width &&
    box.y + box.height <= viewport.height;
  return {
    text,
    insideViewport,
    geometry: `toast=${JSON.stringify(box)} viewport=${JSON.stringify(viewport)}`,
  };
}

/** An attribute a client component sets after mount, waited for rather than
 *  read once. */
async function pollAttribute(locator: Locator, name: string): Promise<string> {
  let value: string | null = null;
  await expect
    .poll(async () => {
      value = await locator.getAttribute(name);
      return value ?? "";
    }, { timeout: 30_000 })
    .not.toBe("");
  return value ?? "";
}

async function supply(page: Page, zip: Buffer, fileName: string): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles({
    name: fileName,
    mimeType: "application/zip",
    buffer: zip,
  });
}

for (const palette of PALETTES) {
  test.describe(`upload screen — ${palette}`, () => {
    for (const kind of ["agent", "skill", "connector", "artifact"] as const) {
      test(`CELL1 ${palette}: a ${kind} archive resolves its kind and draws the store's install panel`, async ({
        page,
      }) => {
        await openUpload(page, palette);
        await supply(page, packageZip(kind), `${kind}.zip`);

        const resolvedKind = page.getByTestId("upload-resolved-kind");
        await expect(resolvedKind).toBeVisible();
        await expect(resolvedKind).toHaveText(
          kind.charAt(0).toUpperCase() + kind.slice(1),
        );
        await expect(page.getByText(packageName(kind))).toBeVisible();

        // The STORE's own panel — its own testids, not a look-alike.
        const panel = page.getByTestId("extension-install-panel-body");
        await expect(panel).toBeVisible();
        await expect(panel).toHaveAttribute("data-availability", "ready");
        await expect(page.getByTestId("extension-install-panel-picker")).toBeVisible();
        await expect(page.getByTestId("extension-install-panel-submit")).toHaveText(
          "Install now",
        );
        await expect(page.getByTestId("extension-install-panel-cancel")).toHaveText("Cancel");
        // Preselected to the broadest audience.
        await expect(page.getByTestId("extension-install-panel-picker")).toContainText(
          "Workspace: All",
        );
        // No popup on this path.
        await expect(page.locator('[role="dialog"]')).toHaveCount(0);
        await shot(page, `cell1-${kind}-${palette}`);
      });
    }

    test(`CELL5 ${palette}: a retired-kind archive is refused by name through the toast surface`, async ({
      page,
    }) => {
      await openUpload(page, palette);
      await supply(page, RETIRED_ZIP, "retired.zip");

      // The refusal names the retired kind, and it is a TOAST — the panel never
      // draws, so nothing about the screen's height or state changed.
      await expect(page.getByText(/retired extension kind/i).first()).toBeVisible();
      await expect(page.getByTestId("upload-install-scope")).toHaveCount(0);

      // The toast is where that sentence lives — and the ONLY place it lives.
      // The file card carries the file and its progress, never the refusal.
      const refused = await readToastSurface(page);
      expect(refused.text).toMatch(/retired extension kind/i);
      expect(refused.insideViewport, refused.geometry).toBe(true);
      const fileCard = page.locator("li").filter({ hasText: "retired.zip" });
      await expect(fileCard).toHaveCount(1);
      await expect(fileCard).not.toContainText(/retired extension kind/i);

      await shot(page, `cell5-${palette}`);
    });

    test(`CELL3 ${palette}: the GitHub tab takes a link with NO GitHub connection`, async ({
      page,
    }) => {
      await openUpload(page, palette);
      await page.getByRole("tab", { name: "GitHub" }).click();

      // THE MAINTAINER'S RULING, in their words: "Anyone can download a ZIP of
      // origin/main of a repo or a ZIP of a release — no need to be logged in at
      // GitHub. The user provides that link and Cinatra gets the ZIP."
      //
      // So this walk runs under the session that holds NO GitHub connection, and
      // what it measures is that nothing is gated: no precondition banner exists
      // at all, and Submit goes live the moment a link is typed.
      await expect(page.getByTestId("github-upload-precondition")).toHaveCount(0);
      const submit = page.getByTestId("github-upload-submit");
      await expect(submit).toBeDisabled(); // no link typed yet
      await page
        .getByLabel("Repository URL")
        .fill("https://github.com/cinatra-ai/cinatra");
      await expect(submit).toBeEnabled();
      await shot(page, `cell3-${palette}`);
    });
  });
}

// ---------------------------------------------------------------------------
// CELL2 — the GITHUB road with a repository actually resolved, and CELL4 — a
// COMPLETED install per kind, observed where the product shows it.
//
// These two walk further than the ones above: they finish the job rather than
// stopping at the panel. They are written as their own describe so a boot that
// cannot reach GitHub still produces every other cell, and so the reason a cell
// could not be measured is STATED by the run rather than left to be guessed.
// ---------------------------------------------------------------------------

/** Choose the scope and press the store's own install action. */
async function installAtChosenScope(page: Page): Promise<void> {
  await expect(page.getByTestId("extension-install-panel-picker")).toBeVisible();
  await page.getByTestId("extension-install-panel-submit").click();
}

for (const palette of PALETTES) {
  test.describe(`upload screen — completing the install — ${palette}`, () => {
    // The three kinds a supplied package can actually reach `finalized` for.
    // A supplied CONNECTOR is refused on purpose: its install exists to run
    // `register(ctx)` in this process and an unsigned supplied package is not
    // admitted to do that. That refusal is its own assertion below — it is the
    // per-kind execution boundary observed from the screen.
    for (const kind of ["agent", "skill", "artifact"] as const) {
      test(`CELL4 ${palette}: a ${kind} package installs and is then visible where that kind lives`, async ({
        page,
      }) => {
        await openUpload(page, palette);
        await supply(page, packageZip(kind), `${kind}.zip`);
        await expect(page.getByTestId("upload-resolved-kind")).toBeVisible();

        await installAtChosenScope(page);

        // The screen's own promise: it navigates to where the kind can be SEEN.
        const observable = {
          agent: "/agents",
          skill: "/skills",
          artifact: "/configuration/extensions",
        }[kind];
        // Anchored at the END of the path on purpose: the upload screen itself
        // lives at /configuration/extensions/upload, so a prefix match would
        // have let the ARTIFACT kind "arrive" at its own listing without ever
        // leaving the form — a green cell for a navigation that never happened.
        await page.waitForURL(new RegExp(`${observable}/?(?:[?#].*)?$`), { timeout: 60_000 });
        await applyPalette(page, palette);
        // The package itself is on the surface that kind is listed on. The
        // agents listing titles a card with the flow's OWN declared name and
        // carries the package only in the addresses that card links to, so the
        // agent cell reads the card by the package path it is addressed at;
        // the other two kinds print the package name as text.
        const installed =
          kind === "agent"
            ? page.locator(
                `a[href="/agents/${packageName(kind).slice(1)}/new"]`,
              )
            : page.getByText(packageName(kind));
        await expect(installed.first()).toBeVisible({ timeout: 30_000 });
        await shot(page, `cell4-${kind}-${palette}`);
      });
    }

    // -----------------------------------------------------------------------
    // THE FOURTH KIND, INSTALLED. The issue's headline is that each of the four
    // kinds installs from a file archive or a resolved repository exactly as the
    // store installs it, and the connector is the kind whose install exists to
    // run `register(ctx)` in this process. A connector that passes the kind gate
    // and declares its access scope installs, and the screen takes the admin to
    // the surface that kind is configured on.
    // -----------------------------------------------------------------------
    test(`CELL4 ${palette}: a supplied CONNECTOR that declares its access scope installs`, async ({
      page,
    }) => {
      await openUpload(page, palette);
      await supply(page, packageZip("connector"), "connector.zip");
      await expect(page.getByTestId("upload-resolved-kind")).toHaveText("Connector");

      await installAtChosenScope(page);

      // The screen's own promise per kind: it goes to where that kind is
      // CONFIGURED — for a connector, its own configuration surface, not a
      // listing. Anchored at the END of the path for the same reason the three
      // cells above are.
      const slug = packageName("connector").split("/")[1] as string;
      await page.waitForURL(
        new RegExp(`/connectors/acme/${slug}/setup/?(?:[?#].*)?$`),
        { timeout: 60_000 },
      );
      await applyPalette(page, palette);
      // The surface the admin was handed to is the connector's OWN
      // configuration page, rendered — never the not-found page a wrong address
      // or a refusing gate produces.
      await expect(page.getByText("Page not found")).toHaveCount(0);
      await expect(page.getByRole("heading", { name: slug })).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.locator('[data-conformance-id="connector-setup"]')).toBeVisible({
        timeout: 30_000,
      });
      // Nothing was refused on the way: no toast carries a refusal.
      await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);
      await shot(page, `cell4-connector-${palette}`);
    });

    test(`CELL4 ${palette}: a connector that declares no access scope is refused by name and the panel keeps the selection`, async ({
      page,
    }) => {
      await openUpload(page, palette);
      await supply(page, undeclaredConnectorZip(), "connector-undeclared.zip");
      await expect(page.getByTestId("upload-resolved-kind")).toHaveText("Connector");

      await installAtChosenScope(page);

      // A toast, never an inline error state, and the panel is exactly as the
      // admin left it — the selection is never lost (design spec §I.1).
      await expect(page.getByText(UNDECLARED_CONNECTOR_NAME).first()).toBeVisible({
        timeout: 60_000,
      });
      await expect(page.getByTestId("extension-install-panel-picker")).toBeVisible();
      await expect(page.getByTestId("extension-install-panel-picker")).toContainText(
        "Workspace: All",
      );

      // THE REFUSAL THE ADMIN ACTUALLY READS. One short sentence in product
      // words — the install chain's own diagnostics (its failure token, the
      // internal issue that closed the absence rule, what it did to the
      // placeholder row) belong in the server log, and a paragraph of them on
      // this surface is what pushed the toast off the top of the window.
      const refusal = await readToastSurface(page);
      expect(refusal.text).not.toMatch(
        /pipeline-threw|supplied-install-failed|\[connector-access-config\]/,
      );
      expect(refusal.text).not.toMatch(/cinatra#\d+/);
      expect(refusal.text).not.toMatch(/roll(?:ed|s|ing)?[ -]?back/i);
      expect(refusal.text.length).toBeLessThan(160);
      // What the package lacks, and what has to be true before it installs.
      expect(refusal.text).toMatch(/configuration/i);
      expect(refusal.text).toMatch(/access scope/i);
      expect(refusal.insideViewport, refusal.geometry).toBe(true);

      await shot(page, `cell4-connector-refused-${palette}`);
    });

  });
}

// ---------------------------------------------------------------------------
// CELL2 — the GITHUB road with a repository actually RESOLVED.
//
// Since the fix leg there is nothing to be connected to: the tab downloads the
// public source archive the link names, anonymously. The cell is kept on its own
// session so a boot that cannot reach the archive host still produces every
// other cell, and so the reason it could not be measured is STATED by the run.
// ---------------------------------------------------------------------------
const GITHUB_STORAGE_STATE = "tests/e2e/extensions-upload/.auth/github-admin-state.json";
const DEFAULT_WALK_REPOSITORY = "https://github.com/cinatra-ai/contract-matcher-skill";

for (const palette of PALETTES) {
  test.describe(`upload screen — the GitHub road resolved — ${palette}`, () => {
    test.use({ storageState: GITHUB_STORAGE_STATE });

    test(`CELL2 ${palette}: the GitHub tab shows the pinned commit, the resolved kind and the same panel`, async ({
      page,
    }) => {
      await openUpload(page, palette);
      await page.getByRole("tab", { name: "GitHub" }).click();

      // A PUBLIC repository whose manifest declares one of the four kinds, so
      // the cell measures the road rather than the reader's refusal. Named here
      // as the default because a cell that quietly skips for want of an
      // environment variable is a cell nobody measured; `E2E_UPLOAD_GITHUB_REPO`
      // still overrides it, and setting it empty states the skip out loud.
      const repo = process.env.E2E_UPLOAD_GITHUB_REPO ?? DEFAULT_WALK_REPOSITORY;
      if (!repo) {
        test.skip(
          true,
          "CELL2 not measurable — no repository was named for the walk (E2E_UPLOAD_GITHUB_REPO).",
        );
        return;
      }

      await page.getByLabel("Repository URL").fill(repo);
      await page.getByTestId("github-upload-submit").click();

      // The PIN, displayed: one immutable commit, resolved once.
      const pinned = page.getByTestId("upload-pinned-sha");
      await expect(pinned).toBeVisible({ timeout: 60_000 });
      await expect(pinned).toHaveText(/pinned at [0-9a-f]{40}$/);
      await expect(page.getByTestId("upload-resolved-kind")).toBeVisible();
      // The RESOLVED state names the archive the bytes actually came from: the
      // repository, the ref and the public archive URL the download used.
      await expect(page.getByTestId("upload-resolved-source")).toContainText(
        /https:\/\/codeload\.github\.com\//,
      );

      // The SAME panel the File tab mounts, with the same preselection.
      await expect(page.getByTestId("extension-install-panel-body")).toBeVisible();
      await expect(page.getByTestId("extension-install-panel-picker")).toContainText(
        "Workspace: All",
      );
      await expect(page.locator('[role="dialog"]')).toHaveCount(0);
      await shot(page, `cell2-${palette}`);
    });
  });
}

// ---------------------------------------------------------------------------
// CELL4, AT THE DEPTH THE CELL NAMES.
//
// The cell reads: "a completed install per kind observed where the product
// shows it: the agent in the agents listing at the chosen scope; the skill on a
// card's skills offer; the artifact type rendering an object of that type; the
// schema-config connector's configuration surface". The three cells above stop
// at the kind's own LISTING — the skills catalog, the installed-extensions
// list. That is the install landing, not the two observables the sentence names
// for the skill and the artifact, and a supplied package can reach the listing
// while reaching neither. The ARTIFACT walk below finishes the artifact
// sentence; the skill's own deeper sentence has no surface left to walk on
// main, and the note where that walk stood says why.
//
// Its package carries its own run tag so this walk installs its OWN artifact
// pack rather than re-installing the row the cells above wrote — a re-install
// over an existing row is a different question with a different answer.
// ---------------------------------------------------------------------------

const DEEP_TAG = `${RUN_TAG}d`;

/** The floor label the artifacts area renders for an undeclared pack id. */
function packLabel(tag: string): string {
  return `upload-walk-${tag}-artifact`
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

async function installThroughUpload(
  page: Page,
  kind: "agent" | "skill" | "connector" | "artifact",
  palette: (typeof PALETTES)[number],
  landing: RegExp,
  tag: string = DEEP_TAG,
): Promise<void> {
  await openUpload(page, palette);
  await supply(page, packageZip(kind, tag), `${kind}.zip`);
  await expect(page.getByTestId("upload-resolved-kind")).toHaveText(
    kind.charAt(0).toUpperCase() + kind.slice(1),
  );
  await installAtChosenScope(page);
  await page.waitForURL(landing, { timeout: 90_000 });
}

for (const palette of PALETTES) {
  test.describe(`upload screen — the installed kind on the surface the cell names — ${palette}`, () => {
    // THE SKILL'S DEEPER OBSERVABLE, WALKED (cinatra#3607).
    //
    // cinatra#3204 criterion 34 asks for "a skill listed on a card that
    // declares it", and criterion 21's skill sentence for the skill "offered
    // on a card that depends on it". The maintainer deferred both halves to
    // epic cinatra#2812 on 2026-09-19, because the only surface that had ever
    // offered an installed skill on a package's own card was the retired
    // extension-settings Skills section. That epic has since landed the
    // surface, so the OFFER half is walked here rather than deferred again:
    // the cell reads the uploaded skill in the card's own chooser and then
    // chooses it, so the card both offers it and carries it.
    //
    // Two halves of those sentences are deliberately NOT claimed. Criterion
    // 21's catalog half, the skill being queryable in the CATALOG by package
    // name, is not this file's: the catalog's own search lives in
    // packages/skills (plugin-pages.tsx filters rows on skill.packageName) and
    // a walk of it belongs with that surface. And "declares" is read here as
    // what an administrator does on the card, not as a manifest edge: the two
    // packages this cell supplies are independent, so what it proves is that
    // the card offers the skill and takes it, never that the agent's manifest
    // names it.
    //
    // WHY THIS SURFACE. The per-scope assignment page (cinatra#2814, landed by
    // pull request 3640) is the page of ONE package, addressed at
    // `<scope-base>/agents/<vendor>/<package>/settings?tab=skills`. Under a
    // scope base it carries that scope alone; under the WORKSPACE base, the
    // one this cell uses, it is the cross-scope editor and draws one section
    // per scope of the reader's vantage, so the cell binds to the workspace
    // section by its own key. Its
    // Skills pane holds the chooser that offers installed skills to that
    // package. It is the card's own page: the card's Settings control is the
    // only link to it, and the cell below reaches it that way. The chooser's
    // population is `listAssignableSkillCandidates()` through
    // `searchScopeSkillCandidates` (src/lib/scope-assignment/
    // scope-assignment-reads.server.ts), so what the cell reads is the
    // product's own offer, not a listing that merely proves the row exists.
    //
    // WHICH SCOPE THE NEGATIVE USES, AND WHY. The Upload screen installs at
    // the scope its own panel is preselected to, `Workspace: All`, which the
    // product persists as a row with no owning organization. The scope reach
    // rule of the per-scope surfaces epic (src/lib/scope-surface-eligibility.ts,
    // `installReachesScope`) admits such a row at the workspace tier and at a
    // personal scope, and refuses it at an ORGANIZATION scope in so many
    // words: "An org-NULL row is NOT an organization's install; it belongs to
    // the workspace tier and surfaces there." The organization is therefore
    // the smallest scope a platform administrator can reach on a fresh
    // instance that is blind to this install, and it is the negative below.
    //
    // WHAT THE NEGATIVE ASSERTS, AND WHAT IT DOES NOT. The organization scope
    // resolves at its own address and the package the install anchored at the
    // workspace has no card on its Agents tab. An absence there needs two
    // controls, because the tab's read answers with no rows when it FAILS as
    // well as when the scope truly reaches nothing, and the route draws the
    // same honest placeholder either way:
    //
    //   1. THE SCOPE ANSWERS. The organization's ASSISTANTS tab renders. That
    //      tab is fail-closed on a read that could not be TAKEN (`if (!ok)
    //      return []`) and consults the directory only on a read that
    //      completed, so an unresolvable anchor or a failed membership read
    //      for this scope and this reader would leave it empty. Those are the
    //      deterministic ways the eligibility read fails, and this rules them
    //      out.
    //   2. THE READ ANSWERS FOR THIS INSTALL. The PERSONAL scope's Agents tab,
    //      drawn by the same function, carries the uploaded card, because the
    //      personal arm admits an install with no owning organization.
    //
    // What neither control rules out is a transient failure of the
    // organization Agents request itself, which is a separate request from
    // both. That residue is the ordinary flake surface every assertion in this
    // file stands on, not a second reading of the sentence.
    //
    // The cell asserts the CARD's absence. It does NOT open a chooser at that
    // scope and read the uploaded skill out of it, and it makes no claim about
    // what any other card of that organization offers.
    //
    // The reason it stops at the card is that the chooser's
    // population carries no install-scope fence on main: an extension's
    // catalog rows are written at the workspace level
    // (packages/skills/src/skills-store.ts), the assignability predicate
    // admits exactly the workspace-visible rows
    // (packages/skills/src/agent-skill-assignability.ts,
    // `isGloballyVisibleCatalogRow`), and the population reads the catalog
    // snapshot with no scope argument. Among the candidates that predicate
    // admits, what narrows a chooser today is the typed query, the exclusion
    // of a package whose install rows are all archived, and the subtraction of
    // the skills that exact scope already chose. The install's own scope
    // narrows nothing. Fencing the offer to it is a product decision for the
    // assignment epic, and this walk states where the fence is today rather
    // than asserting one that is not there.

    test(`CELL4 ${palette}: the uploaded skill is offered on the card at the scope the install chose, and that card is absent from a scope blind to the install`, async ({
      page,
    }) => {
      // This cell supplies TWO packages through the screen and then walks four
      // surfaces, and on a development server the assignment route pays its
      // first compile inside the cell. The suite's own budget is written for a
      // cell that supplies one package, so this one asks for the longer one.
      test.slow();
      // This cell's OWN tag, one per palette: it installs an agent package
      // (the card) and a skill package (the offer), and the walk's tagging
      // rule forbids re-installing over a row another cell or the other
      // palette already wrote.
      const tag = `${RUN_TAG}c${palette.charAt(0)}`;
      const agentSlug = packageName("agent", tag).split("/")[1] as string;
      const skillName = walkSkillCatalogName(tag);

      // THE CARD. An assignment page is the page of a package, so the cell
      // supplies its own agent package at the scope the panel chooses.
      await installThroughUpload(page, "agent", palette, /\/agents\/?(?:[?#].*)?$/, tag);
      // THE OFFER. The same screen, the same road, the same chosen scope.
      await installThroughUpload(page, "skill", palette, /\/skills\/?(?:[?#].*)?$/, tag);

      // ---------------------------------------------------------------------
      // THE POSITIVE READING.
      // ---------------------------------------------------------------------
      // Reached the way an admin reaches it: the scope's own landing, the tab
      // strip that page draws, then the card's own Settings link.
      await page.goto("/workspace");
      await applyPalette(page, palette);
      await page.getByRole("tab", { name: "Agents" }).click();
      await page.waitForURL(/\/workspace\/agents\/?(?:[?#].*)?$/, { timeout: 60_000 });
      await applyPalette(page, palette);

      // The scope drew its card list, and the uploaded package is on it. The
      // card is read by the address its controls carry, because the card's
      // title is the flow's own declared name rather than the package name.
      await expect(page.getByTestId("scope-agents-list")).toBeVisible({ timeout: 60_000 });
      const settingsLink = page.locator(
        `a[href="/workspace/agents/acme/${agentSlug}/settings?tab=skills"]`,
      );
      await expect(settingsLink).toHaveCount(1, { timeout: 30_000 });
      await settingsLink.click();
      await page.waitForURL(
        new RegExp(`/workspace/agents/acme/${agentSlug}/settings\\?(?:.*&)?tab=skills(?:[&#]|$)`),
        { timeout: 60_000 },
      );
      await applyPalette(page, palette);

      // The card's own page, with its Skills pane and a live chooser. The
      // workspace page is the CROSS-SCOPE editor, so it draws one section per
      // scope of the reader's vantage; the cell binds to the workspace
      // section by its own key rather than to whichever section is drawn
      // first, or it would read and write at a scope it never named.
      await expect(page.getByTestId("scope-assignment-page")).toBeVisible({ timeout: 30_000 });
      const pane = page.locator('[data-slot="scope-assignment-skills-pane"]');
      await expect(pane).toBeVisible({ timeout: 30_000 });
      const section = pane.locator(
        '[data-slot="scope-assignment-section"][data-scope-key="workspace"]',
      );
      await expect(section).toHaveCount(1, { timeout: 30_000 });
      const chooser = section.locator('input[role="combobox"]');
      await expect(chooser).toBeVisible({ timeout: 30_000 });

      // THE SENTENCE ITSELF: the uploaded skill is OFFERED, by the name the
      // package gives it, on the chooser's OWN list. The option is read inside
      // the list the chooser opened rather than anywhere on the page, and it
      // has to carry the uploaded PACKAGE's name beside the skill's. Both
      // reads are substring reads, so what they rule out is a row of some
      // OTHER package and a row of some other skill of the same package; the
      // fixture supplies exactly one skill in a package named for this run, so
      // on this instance one row can satisfy them.
      await chooser.fill(skillName);
      // The list this chooser opened, named by the chooser itself: the input
      // publishes its popup's id as `aria-controls`, so the option below is
      // read out of THAT list rather than out of whatever listbox the page
      // happens to hold.
      const listId = await pollAttribute(chooser, "aria-controls");
      const list = page.locator(`[id="${listId.replaceAll('"', '\\"')}"]`);
      await expect(list).toBeVisible({ timeout: 60_000 });
      const offered = list.getByRole("option").filter({ hasText: skillName });
      await expect(offered).toHaveCount(1, { timeout: 60_000 });
      await expect(offered.first()).toBeVisible();
      await expect(offered.first()).toContainText(packageName("skill", tag));
      await shot(page, `cell4-skill-offered-${palette}`);

      // …and the card TAKES it: choosing the offered row leaves the skill on
      // the card as a chosen row of its own, saved and active. An offer the
      // card cannot accept would stop here.
      await offered.first().click();
      const chosen = section.locator(
        '[data-slot="scope-skills-row"]:not([data-status="saving"])',
      );
      await expect(chosen).toHaveCount(1, { timeout: 60_000 });
      await expect(chosen).toHaveAttribute("data-status", "ok");
      await expect(chosen).toContainText(skillName);
      await expect(section.locator('[data-slot="scope-skills-error"]')).toHaveCount(0);
      await shot(page, `cell4-skill-chosen-${palette}`);

      // ---------------------------------------------------------------------
      // THE NEGATIVE READING.
      // ---------------------------------------------------------------------
      // The organization this reader belongs to, read off the product's own
      // page rather than guessed: the workspace page is the cross-scope
      // editor, and it labels one section per scope of the reader's vantage.
      const orgSections = page.locator(
        '[data-slot="scope-assignment-section"][data-scope-key^="organization:"]',
      );
      // Exactly one on a fresh instance, so the id below names the scope this
      // reader actually belongs to rather than whichever section came first.
      await expect(orgSections).toHaveCount(1, { timeout: 30_000 });
      const orgKey = (await orgSections.first().getAttribute("data-scope-key")) ?? "";
      const orgId = encodeURIComponent(orgKey.slice("organization:".length));
      expect(orgId.length).toBeGreaterThan(0);

      // THE SCOPE'S OWN ELIGIBILITY READ, PROVEN TO HAVE COMPLETED. An empty
      // Agents tab alone would prove nothing: that read is caught and answered
      // with no rows when it FAILS
      // (src/lib/scope-surface-eligibility.server.ts), and the route draws the
      // same honest placeholder for a failed read as for a scope that reaches
      // nothing. The ASSISTANTS tab of the same scope is where the two come
      // apart, in that module's own words: a read that could not be taken
      // renders nothing there, while a read that COMPLETED consults the
      // directory and surfaces the built-in platform assistant, which is no
      // install row at all. So the cell reads the assistants tab first, and
      // only a scope whose fence actually ran can show it.
      await page.goto(`/organizations/${orgId}/assistants`);
      await applyPalette(page, palette);
      await expect(page).toHaveURL(
        new RegExp(`/organizations/${orgId}/assistants(?:[?#]|$)`),
      );
      await expect(page.getByTestId("scope-assistants-list")).toBeVisible({ timeout: 60_000 });

      // THE SAME READER, THE SAME READ, AT A SCOPE THAT IS NOT BLIND. The
      // personal scope admits an install with no owning organization
      // (`installReachesScope`, the personal arm), and its Agents tab is drawn
      // by the very function the organization's Agents tab is drawn by. Taking
      // it here shows that function answering with the uploaded card for this
      // reader, moments before the organization's tab is read, so the absence
      // below stands against a working read rather than against nothing.
      await page.goto("/personal/agents");
      await applyPalette(page, palette);
      await expect(
        page.locator(`a[href^="/personal/agents/acme/${agentSlug}/"]`).first(),
      ).toBeVisible({ timeout: 60_000 });

      // Back to the organization, and on through the scope's own tab strip as
      // an admin goes: the Agents tab of THIS organization, not a typed
      // address.
      await page.goto(`/organizations/${orgId}/assistants`);
      await applyPalette(page, palette);
      await expect(page.getByTestId("scope-assistants-list")).toBeVisible({ timeout: 60_000 });
      await page.getByRole("tab", { name: "Agents" }).click();
      await page.waitForURL(new RegExp(`/organizations/${orgId}/agents(?:[?#]|$)`), {
        timeout: 60_000,
      });
      await applyPalette(page, palette);

      // The page resolved to this scope and drew its body: the card list, or
      // the honest placeholder. The absence is read only once one of the two
      // is on the screen, so an empty list cannot be a list that had not
      // arrived yet.
      await expect(page.getByRole("tab", { name: "Agents" })).toBeVisible({ timeout: 60_000 });
      const orgList = page.getByTestId("scope-agents-list");
      const orgEmpty = page.getByTestId("scope-agents-empty");
      await expect(orgList.or(orgEmpty)).toBeVisible({ timeout: 60_000 });

      // THE SENTENCE'S OTHER HALF: the package the install anchored at the
      // workspace has no card at this scope.
      await expect(
        page.locator(`a[href^="/organizations/${orgId}/agents/acme/${agentSlug}/"]`),
      ).toHaveCount(0);
      await shot(page, `cell4-skill-not-offered-${palette}`);
    });

    test(`CELL4 ${palette}: an object made in the artifacts area files under the pack's declared type, and the type filter offers it`, async ({
      page,
    }) => {
      await installThroughUpload(
        page,
        "artifact",
        palette,
        /\/configuration\/extensions\/?(?:[?#].*)?$/,
      );

      // A taller window for this cell alone: the picker lists EVERY installed
      // type that accepts the file's MIME, and on an instance carrying many of
      // them the declared row sits below the fold of the default window — the
      // walk would then be measuring the window, not the offer.
      await page.setViewportSize({ width: 1440, height: 1800 });
      await page.goto("/artifacts");
      await applyPalette(page, palette);

      // The area's OWN upload control, and its own type picker.
      await page.locator('input[data-testid="artifacts-upload-input"]').setInputFiles({
        name: `upload-walk-${DEEP_TAG}.txt`,
        mimeType: "text/plain",
        buffer: Buffer.from("A note supplied by the upload walk.\n"),
      });
      // The filed upload's own "what is this?" affordance opens the area's type
      // picker — the control an admin uses, not a dialog opened by the walk.
      const setMeaning = page.getByTestId("artifacts-set-meaning");
      await expect(setMeaning).toBeVisible({ timeout: 90_000 });
      await setMeaning.click();
      const picker = page.locator('[data-conformance-id="artifacts-type-picker"]');
      await expect(picker).toBeVisible({ timeout: 30_000 });

      // The DECLARED type is on offer — not the built-in floor alone.
      const declaredType = `${packageName("artifact", DEEP_TAG)}:note`;
      const row = page.getByTestId("artifacts-picker-type").filter({ hasText: declaredType });
      await expect(row).toHaveCount(1, { timeout: 60_000 });
      await shot(page, `cell4-artifact-type-offered-${palette}`);
      await row.scrollIntoViewIfNeeded();
      await row.click();
      await page.getByTestId("artifacts-picker-confirm").click();

      // …and the object is FILED under it: the area's own type filter now
      // carries the pack, and the row reads as that type rather than as Text.
      const label = packLabel(DEEP_TAG);
      await expect(page.getByText(`upload-walk-${DEEP_TAG}.txt`).first()).toBeVisible({
        timeout: 60_000,
      });
      await page.getByTestId("artifacts-facet").click();
      const option = page.getByRole("option").filter({ hasText: label });
      await expect(option.first()).toBeVisible({ timeout: 30_000 });
      await option.first().click();
      await expect(page.getByText(`upload-walk-${DEEP_TAG}.txt`).first()).toBeVisible({
        timeout: 30_000,
      });
      await shot(page, `cell4-artifact-filed-${palette}`);
    });
  });
}
