/**
 * Canonical artifact-backed blog record shape gate. Asserts the
 * asset-blog TS record interfaces do not declare body / byte fields.
 * The canonical records are:
 *
 *   - `@cinatra-ai/blog-post-artifact`  — post body + LinkedIn copy
 *   - `@cinatra-ai/blog-idea-artifact`  — idea summary
 *   - `@cinatra-ai/blog-image-artifact` — hero / inline + saved-media bytes
 *
 * The host record interfaces carry `*ArtifactId` +
 * `*RepresentationRevisionId` refs only.
 *
 * Static grep — runs without a DB. Mirrors the highest
 * blast-radius risk guard: catches regressions where a future edit
 * re-adds bytes / body strings to the record interfaces.
 *
 *   pnpm --filter @cinatra-ai/extensions exec vitest run \
 *     src/__tests__/abc27-canonical-record-shape.test.ts
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Blog sources live under `src/lib/blog/`. Resolve from
// packages/extensions/src/__tests__/ to repo root to src/lib/blog/.
const BLOG_SRC = resolve(
  __dirname,
  "..",
  "..",
  "..",
  "..",
  "src",
  "lib",
  "blog",
);
const STORE_PATH = resolve(BLOG_SRC, "store.ts");
const REGISTER_PATH = resolve(
  BLOG_SRC,
  "integration",
  "register-object-types.ts",
);

function extractInterface(source: string, name: string): string {
  const re = new RegExp(`export type ${name} = \\{[\\s\\S]*?\\n\\};`);
  const match = source.match(re);
  if (!match) {
    throw new Error(`${name} not found in ${STORE_PATH}`);
  }
  return match[0];
}

// Extractors target the canonical `@cinatra-ai/assets:*` namespace
// registered by `registerAssetsBlogObjectTypes`. The bytes-free /
// artifact-ref invariant still applies.
function extractBlogPostSchema(source: string): string {
  const re =
    /type:\s*"@cinatra-ai\/assets:blog-post"[\s\S]*?schema:\s*z\.object\(\{([\s\S]*?)\}\),[\s\S]*?lifecycle/;
  const match = source.match(re);
  if (!match) {
    throw new Error("blog-post zod schema not found");
  }
  return match[1];
}

function extractBlogIdeaSchema(source: string): string {
  const re =
    /type:\s*"@cinatra-ai\/assets:blog-idea"[\s\S]*?schema:\s*z\.object\(\{([\s\S]*?)\}\),[\s\S]*?lifecycle/;
  const match = source.match(re);
  if (!match) {
    throw new Error("blog-idea zod schema not found");
  }
  return match[1];
}

describe("blog-post record carries image refs, not bytes", () => {
  const storeSrc = readFileSync(STORE_PATH, "utf-8");
  const registerSrc = readFileSync(REGISTER_PATH, "utf-8");

  it("BlogPostDraftRecord does NOT declare image-byte fields", () => {
    const def = extractInterface(storeSrc, "BlogPostDraftRecord");
    expect(def).not.toMatch(/\bimageBase64\s*[?:]/);
    expect(def).not.toMatch(/\bimageMimeType\s*[?:]/);
    expect(def).not.toMatch(/\bimage_bytes\b/);
    expect(def).not.toMatch(/\bimage_data\b/);
  });

  it("BlogPostDraftRecord DOES declare image-artifact refs", () => {
    const def = extractInterface(storeSrc, "BlogPostDraftRecord");
    expect(def).toMatch(/\bimageArtifactId\?\s*:\s*string;/);
    expect(def).toMatch(/\bimageRepresentationRevisionId\?\s*:\s*string;/);
  });

  it("blog-post object-type zod schema is bytes-free", () => {
    const schema = extractBlogPostSchema(registerSrc);
    expect(schema).not.toMatch(/imageBase64\s*:/);
    expect(schema).not.toMatch(/imageMimeType\s*:/);
    expect(schema).toMatch(/imageArtifactId\s*:/);
    expect(schema).toMatch(/imageRepresentationRevisionId\s*:/);
  });
});

// The post body / idea summary / LinkedIn copy / saved-media bytes all
// live in semantic artifacts. The host record interfaces forbid body /
// byte fields; the corresponding *ArtifactId + *RepresentationRevisionId
// refs are the canonical reference.
describe("blog-post body lives in blog-post-artifact, not on the record", () => {
  const storeSrc = readFileSync(STORE_PATH, "utf-8");
  const registerSrc = readFileSync(REGISTER_PATH, "utf-8");

  it("BlogPostDraftRecord does NOT declare a post-body string field", () => {
    const def = extractInterface(storeSrc, "BlogPostDraftRecord");
    expect(def).not.toMatch(/\bcontent\s*:\s*string;/);
    expect(def).not.toMatch(/\bbody\s*:\s*string;/);
  });

  it("BlogPostDraftRecord DOES declare post-body-artifact refs", () => {
    const def = extractInterface(storeSrc, "BlogPostDraftRecord");
    expect(def).toMatch(/\bpostArtifactId\?\s*:\s*string;/);
    expect(def).toMatch(/\bpostRepresentationRevisionId\?\s*:\s*string;/);
  });

  it("BlogPostDraftRecord.linkedinDrafts[] does NOT declare a content string field", () => {
    const def = extractInterface(storeSrc, "BlogPostDraftRecord");
    // The inline `linkedinDrafts: Array<{ ... }>` shape sits inside
    // BlogPostDraftRecord; the inline content field would surface as
    // `content: string;` inside that nested type.
    const linkedinShape = def.match(/linkedinDrafts\?:\s*Array<\{([\s\S]*?)\}>/);
    expect(linkedinShape).toBeTruthy();
    expect(linkedinShape![1]).not.toMatch(/\bcontent\s*:\s*string;/);
  });

  it("BlogPostDraftRecord.linkedinDrafts[] DOES declare content-artifact refs", () => {
    const def = extractInterface(storeSrc, "BlogPostDraftRecord");
    const linkedinShape = def.match(/linkedinDrafts\?:\s*Array<\{([\s\S]*?)\}>/);
    expect(linkedinShape).toBeTruthy();
    expect(linkedinShape![1]).toMatch(/\bcontentArtifactId\?\s*:\s*string;/);
    expect(linkedinShape![1]).toMatch(/\bcontentRepresentationRevisionId\?\s*:\s*string;/);
  });

  it("blog-post object-type zod schema is body-string-free", () => {
    const schema = extractBlogPostSchema(registerSrc);
    expect(schema).not.toMatch(/\bcontent\s*:\s*z\.string\(/);
    expect(schema).toMatch(/postArtifactId\s*:/);
    expect(schema).toMatch(/postRepresentationRevisionId\s*:/);
  });
});

describe("blog-post-idea summary lives in blog-idea-artifact, not on the record", () => {
  const storeSrc = readFileSync(STORE_PATH, "utf-8");
  const registerSrc = readFileSync(REGISTER_PATH, "utf-8");

  it("BlogPostIdeaRecord does NOT declare summary as a string field", () => {
    const def = extractInterface(storeSrc, "BlogPostIdeaRecord");
    expect(def).not.toMatch(/\bsummary\s*:\s*string;/);
  });

  it("BlogPostIdeaRecord DOES declare summary-artifact refs", () => {
    const def = extractInterface(storeSrc, "BlogPostIdeaRecord");
    expect(def).toMatch(/\bsummaryArtifactId\?\s*:\s*string;/);
    expect(def).toMatch(/\bsummaryRepresentationRevisionId\?\s*:\s*string;/);
  });

  it("blog-post-idea object-type zod schema is summary-string-free", () => {
    const schema = extractBlogIdeaSchema(registerSrc);
    expect(schema).not.toMatch(/\bsummary\s*:\s*z\.string\(/);
    expect(schema).toMatch(/summaryArtifactId\s*:/);
    expect(schema).toMatch(/summaryRepresentationRevisionId\s*:/);
  });
});

describe("saved-media bytes live in blog-image-artifact, not on the record", () => {
  const storeSrc = readFileSync(STORE_PATH, "utf-8");
  const registerSrc = readFileSync(REGISTER_PATH, "utf-8");

  it("SavedMediaRecord does NOT declare image-byte fields", () => {
    const def = extractInterface(storeSrc, "SavedMediaRecord");
    expect(def).not.toMatch(/\bimageBase64\s*[?:]/);
    expect(def).not.toMatch(/\bimageMimeType\s*[?:]/);
  });

  it("SavedMediaRecord DOES declare image-artifact refs", () => {
    const def = extractInterface(storeSrc, "SavedMediaRecord");
    expect(def).toMatch(/\bimageArtifactId\?\s*:\s*string;/);
    expect(def).toMatch(/\bimageRepresentationRevisionId\?\s*:\s*string;/);
  });

  // The `@cinatra-ai/asset-blog:saved-media` object type has no canonical
  // replacement and no current writers. The schema is not registered, so
  // this assertion is obsolete; the surviving `SavedMediaRecord` interface
  // checks above keep the byte-free contract on the TS record layer.
  it.skip("saved-media object-type zod schema is not registered", () => {});
});
