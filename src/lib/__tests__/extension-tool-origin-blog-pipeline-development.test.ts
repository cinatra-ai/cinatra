/**
 * THE BLOG PIPELINE'S EMBEDDED CHILD STEPS ON A DEVELOPMENT INSTALLATION (cinatra#3033).
 *
 * The real pair, read from the pinned tree: the pipeline's flow embeds the draft
 * writer's and the image generator's own `read_brand_voice` steps, each of which
 * asks for its child's `brand_voice_text` tool. On a development installation
 * there is no install row, so the origin resolver reads both sides by name and
 * version: the version each child's generated record carries, under the range the
 * pipeline's generated record declares for it. Nothing here is a fixture: the
 * versions, ranges and source directories come from the generated manifest, and
 * the flow and package manifests are the pinned packs' own files.
 *
 * The extension tree is not committed. Without it the case is skipped, unless
 * CINATRA_REQUIRE_EXTENSIONS=1 is set where the pinned sync ran.
 *
 *   pnpm vitest run src/lib/__tests__/extension-tool-origin-blog-pipeline-development.test.ts
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { satisfiesConstraint } from "@/lib/extension-tool-install-binding";

import { STATIC_EXTENSION_MANIFEST } from "@/lib/generated/extensions.server";

import { resolveExtensionToolOrigin, type ExtensionToolOriginDeps } from "../extension-tool-origin";

const REPO_ROOT = path.resolve(__dirname, "../../..");
const PIPELINE = "@cinatra-ai/blog-pipeline-agent";

type Record_ = {
  version: string;
  sourceDir: string;
  dependencies?: { packageName: string; kind?: string; versionConstraint: { kind: string; range: string } }[];
};
const manifest = STATIC_EXTENSION_MANIFEST as unknown as Record<string, Record_ | undefined>;

const pipelineRecord = manifest[PIPELINE];
const HAS_TREE =
  pipelineRecord !== undefined && existsSync(path.join(REPO_ROOT, pipelineRecord.sourceDir, "cinatra", "oas.json"));
const REQUIRE_EXTENSIONS = process.env.CINATRA_REQUIRE_EXTENSIONS === "1";

/** The development source road: the generated record's directory, at exactly the version it pins. */
const sourceRoot: NonNullable<ExtensionToolOriginDeps["resolveDevelopmentRoot"]> = async ({
  packageName,
  packageVersion,
  installId,
}) => {
  if (installId !== undefined) return null;
  const record = manifest[packageName];
  if (!record || record.version !== packageVersion) return null;
  const root = path.join(REPO_ROOT, record.sourceDir);
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
  return pkg.name === packageName && pkg.version === packageVersion ? root : null;
};

const CASES = [
  { child: "@cinatra-ai/blog-draft-writer-agent", step: "blog-draft-writer-agent__read_brand_voice", range: "^0.2.2", version: "0.2.2" },
  { child: "@cinatra-ai/blog-image-generator-agent", step: "blog-image-generator-agent__read_brand_voice", range: "^0.1.4", version: "0.1.4" },
] as const;

describe.skipIf(!HAS_TREE && !REQUIRE_EXTENSIONS)(
  "the blog pipeline's embedded brand-voice steps on a development installation",
  () => {
    it("has the pinned tree", () => {
      expect(HAS_TREE, "CINATRA_REQUIRE_EXTENSIONS=1 but the pipeline's pinned source is absent").toBe(true);
    });

    for (const { child, step, range, version } of CASES) {
      it(`declares ${child} within a range its pinned version meets`, () => {
        const edges = (pipelineRecord?.dependencies ?? []).filter((d) => d.packageName === child);
        expect(edges.map((d) => [d.kind, d.versionConstraint.range])).toEqual([["agent", range]]);
        expect(manifest[child]?.version).toBe(version);
        expect(satisfiesConstraint(version, edges[0].versionConstraint)).toBe(true);
      });

      it(`runs ${child}'s own brand_voice_text tool for the pipeline's ${step} step`, async () => {
        const deps = {
          deriveDependentInstallId: vi.fn(async () => ({ kind: "none" as const })),
          isDevelopmentMode: vi.fn(() => true),
          resolveDevelopmentRoot: vi.fn(sourceRoot),
          readInstalledExtensionById: vi.fn(async () => null),
        } satisfies ExtensionToolOriginDeps;
        const origin = await resolveExtensionToolOrigin(
          {
            run: {
              id: "run-1", orgId: "org-1", templateId: "tmpl-1", packageVersion: pipelineRecord!.version,
              dependentInstallId: null, verifiedStepId: step,
            },
            context: { packageName: PIPELINE, packageVersion: pipelineRecord!.version, cinatra: {} },
            request: { name: "brand_voice_text", input: {} },
          },
          deps,
        );
        expect(origin.kind).toBe("child");
        if (origin.kind !== "child") return;
        expect(origin.install).toBeNull();
        expect(origin.codeInstallId).toBeNull();
        expect(origin.context.packageName).toBe(child);
        expect(origin.context.packageVersion).toBe(version);
        const tools = (origin.context.cinatra as { tools?: { name: string; embeddable?: boolean }[] }).tools ?? [];
        expect(tools.find((t) => t.name === "brand_voice_text")?.embeddable).toBe(true);
        for (const [arg] of deps.resolveDevelopmentRoot.mock.calls) expect(arg.installId).toBeUndefined();
      });
    }
  },
);
