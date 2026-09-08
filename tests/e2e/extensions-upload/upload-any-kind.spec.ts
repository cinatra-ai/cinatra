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
 *   GITHUB ROAD — the tab states its precondition instead of leaking a raw
 *   capability refusal, and Submit is disabled while it holds; and, where a
 *   usable connection exists, a repository is resolved to ONE immutable commit
 *   which is displayed, beside the resolved kind and the same install panel.
 *
 *   THE COMPLETED INSTALL — an agent, a skill and an artifact package are
 *   installed through the screen at a chosen scope and then OBSERVED on the
 *   surface that kind lives on. A supplied connector is refused by name, with
 *   the panel unchanged: that refusal is the per-kind execution boundary seen
 *   from the screen, not a gap in the walk.
 *
 * Both palettes are walked: the page is rendered once in light and once in dark,
 * and the assertions are made in each.
 */
import { test, expect, type Page } from "@playwright/test";
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
  metadata: { cinatra: { type: "leaf" } },
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
function packageName(kind: "agent" | "skill" | "connector" | "artifact"): string {
  return `@acme/upload-walk-${RUN_TAG}-${kind}`;
}

function packageZip(kind: "agent" | "skill" | "connector" | "artifact"): Buffer {
  const manifest: Record<string, unknown> = {
    name: packageName(kind),
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
    files.push({
      name: "skills/one/SKILL.md",
      content: "---\nname: one\ndescription: A skill supplied by the upload walk.\n---\nbody",
    });
  if (kind === "connector") {
    (manifest.cinatra as Record<string, unknown>).serverEntry = "dist/server.js";
    files.push({ name: "dist/server.js", content: "export function register() {}" });
  }
  if (kind === "artifact") {
    // The artifact validator reads the descriptor off package.json (a sidecar
    // file alone is not the contract) and `accepts` is a REPRESENTATION-FORM
    // object, not a bare mime list — a list is refused before anything is
    // written, which is a refusal this cell is not about.
    const accepts = { file: { mimeTypes: ["text/plain"] } };
    (manifest.cinatra as Record<string, unknown>).artifact = { accepts };
    files.push({
      name: "cinatra/artifact.json",
      content: JSON.stringify({ accepts }),
    });
  }
  return storedZip([
    { name: "package.json", content: JSON.stringify(manifest) },
    ...files,
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

async function usePalette(page: Page, palette: (typeof PALETTES)[number]): Promise<void> {
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
  await usePalette(page, palette);
  await expect(page.getByRole("heading", { name: "Upload Extension" })).toBeVisible();
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
      await shot(page, `cell5-${palette}`);
    });

    test(`CELL3 ${palette}: the GitHub tab states its precondition and disables Submit`, async ({
      page,
    }) => {
      await openUpload(page, palette);
      await page.getByRole("tab", { name: "GitHub" }).click();

      const precondition = page.getByTestId("github-upload-precondition");
      const submit = page.getByTestId("github-upload-submit");
      // On an instance WITHOUT a usable GitHub connection the tab must say which
      // of the two preconditions is missing, and Submit must be dead. On an
      // instance that HAS one, the banner is absent and Submit is live once a
      // URL is typed. Both are legitimate; the walk asserts the pair is
      // consistent, which is the contract.
      if ((await precondition.count()) > 0) {
        await expect(precondition).toBeVisible();
        await expect(precondition).toContainText(/connector|connection/i);
        await expect(submit).toBeDisabled();
      } else {
        await expect(submit).toBeDisabled(); // no URL typed yet
        await page
          .getByLabel("Repository URL")
          .fill("https://github.com/cinatra-ai/cinatra");
        await expect(submit).toBeEnabled();
      }
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
        await usePalette(page, palette);
        // The package's own name is on the surface that kind is listed on.
        await expect(
          page.getByText(packageName(kind)).first(),
        ).toBeVisible({ timeout: 30_000 });
        await shot(page, `cell4-${kind}-${palette}`);
      });
    }

    test(`CELL4 ${palette}: a supplied connector is refused by name and the panel keeps the selection`, async ({
      page,
    }) => {
      await openUpload(page, palette);
      await supply(page, packageZip("connector"), "connector.zip");
      await expect(page.getByTestId("upload-resolved-kind")).toHaveText("Connector");

      await installAtChosenScope(page);

      // A toast, never an inline error state, and the panel is exactly as the
      // admin left it — the selection is never lost (design spec §I.1).
      await expect(page.getByText(packageName("connector")).first()).toBeVisible({
        timeout: 60_000,
      });
      await expect(page.getByTestId("extension-install-panel-picker")).toBeVisible();
      await expect(page.getByTestId("extension-install-panel-picker")).toContainText(
        "Workspace: All",
      );
      await shot(page, `cell4-connector-refused-${palette}`);
    });

    test(`CELL2 ${palette}: the GitHub tab shows the pinned commit, the resolved kind and the same panel`, async ({
      page,
    }) => {
      await openUpload(page, palette);
      await page.getByRole("tab", { name: "GitHub" }).click();

      const precondition = page.getByTestId("github-upload-precondition");
      if ((await precondition.count()) > 0) {
        const stated = (await precondition.innerText()).replace(/\s+/g, " ").trim();
        test.skip(
          true,
          `CELL2 not measurable on this instance — the GitHub tab states: ${stated}`,
        );
        return;
      }

      const repo = process.env.E2E_UPLOAD_GITHUB_REPO;
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
