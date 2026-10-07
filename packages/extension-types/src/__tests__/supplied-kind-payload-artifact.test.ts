/**
 * THE ARTIFACT BRANCH of the shared supplied-package reader (cinatra#3600).
 *
 * Every artifact package this product ships keeps its configuration INLINE in
 * package.json at `cinatra.artifact`, and that is the only place the artifact
 * installer ever reads. The reader must therefore accept that block as the
 * kind's payload — while a declared `cinatra.entrypoint` stays valid AND stays
 * strict, the conventional `cinatra/artifact.json` stays a valid alternative,
 * and a package that declares kind `artifact` with NONE of the three stays
 * refused.
 *
 * The entry maps are built inline in this file: this suite has no filesystem,
 * no network and no execution, and it mocks nothing.
 *
 * Run: cd packages/extension-types && pnpm exec vitest run src/__tests__/supplied-kind-payload-artifact.test.ts
 */
import { describe, expect, it } from "vitest";

import { resolveSuppliedPackageTree } from "../index";

const enc = new TextEncoder();

/** A delivery, by delivery-relative path. */
const tree = (files: Record<string, string>) =>
  new Map(Object.entries(files).map(([path, text]) => [path, enc.encode(text)] as const));

const manifest = (cinatra: Record<string, unknown>) =>
  JSON.stringify({
    name: "@acme/thing-artifact",
    version: "1.0.0",
    cinatra: { kind: "artifact", ...cinatra },
  });

/** The shape the shipped packs carry: metadata only, inline. */
const INLINE_BLOCK = { accepts: { file: { mimeTypes: ["text/markdown"] } } };
const DESCRIPTOR = JSON.stringify(INLINE_BLOCK);

describe("the artifact branch takes the inline cinatra.artifact declaration (cinatra#3600)", () => {
  it("accepts a package shaped like the shipped packs — inline block only — and carries package.json as the payload", async () => {
    const declared = manifest({ artifact: INLINE_BLOCK });
    const resolved = await resolveSuppliedPackageTree(tree({ "package.json": declared }));
    expect(resolved.kind).toBe("artifact");
    expect(resolved.packageName).toBe("@acme/thing-artifact");
    expect(resolved.version).toBe("1.0.0");
    expect([...resolved.payload.keys()]).toEqual(["package.json"]);
    expect(resolved.payload.get("package.json")).toBe(declared);
  });

  it("still refuses a package that declares kind artifact with none of the three, naming the inline block first", async () => {
    await expect(
      resolveSuppliedPackageTree(tree({ "package.json": manifest({}), "README.md": "hi" })),
    ).rejects.toThrow(
      /declares kind "artifact" but does not contain an artifact declaration \(a package\.json "cinatra\.artifact" block, a package\.json "cinatra\.entrypoint", or a cinatra\/artifact\.json\)/,
    );
  });

  it("keeps the conventional cinatra/artifact.json a valid alternative", async () => {
    const resolved = await resolveSuppliedPackageTree(
      tree({ "package.json": manifest({}), "cinatra/artifact.json": DESCRIPTOR }),
    );
    expect(resolved.kind).toBe("artifact");
    expect([...resolved.payload.keys()]).toEqual(["cinatra/artifact.json"]);
    expect(resolved.payload.get("cinatra/artifact.json")).toBe(DESCRIPTOR);
  });

  it("keeps a declared entrypoint valid and keeps it strict", async () => {
    const delivered = await resolveSuppliedPackageTree(
      tree({
        "package.json": manifest({ entrypoint: "cinatra/custom.json" }),
        "cinatra/custom.json": DESCRIPTOR,
      }),
    );
    expect(delivered.kind).toBe("artifact");
    expect([...delivered.payload.keys()]).toEqual(["cinatra/custom.json"]);

    // A package that NAMES a file and does not ship it is refused by that name
    // whatever else it declares — an inline block does not excuse the lie.
    await expect(
      resolveSuppliedPackageTree(
        tree({
          "package.json": manifest({ entrypoint: "cinatra/custom.json", artifact: INLINE_BLOCK }),
        }),
      ),
    ).rejects.toThrow(/does not contain the entrypoint "cinatra\/custom\.json" that package\.json names/);

    // An entrypoint DECLARED as an empty string (or as "./", which normalises to
    // the same) is still a declaration: it is refused by name here as it was
    // before this change, never silently resolved through another form.
    for (const declared of ["", "./"]) {
      await expect(
        resolveSuppliedPackageTree(
          tree({
            "package.json": manifest({ entrypoint: declared, artifact: INLINE_BLOCK }),
            "cinatra/artifact.json": DESCRIPTOR,
          }),
        ),
      ).rejects.toThrow(/does not contain the entrypoint "" that package\.json names/);
    }
  });
});
