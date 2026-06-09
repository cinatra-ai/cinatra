import { describe, it, expect } from "vitest";
import { stripComments } from "../lib/strip-comments.mjs";

describe("strip-comments (shared audit-gate lexer)", () => {
  it("strips plain line comments but keeps the code after the newline", () => {
    const out = stripComments('// note about @scope/pkg\nimport x from "@scope/pkg";\n');
    expect(out).not.toContain("note about");
    expect(out).toContain('import x from "@scope/pkg";');
  });

  it("strips block comments and preserves line structure", () => {
    const out = stripComments('/* one\ntwo @scope/pkg */\nconst a = 1;\n');
    expect(out).not.toContain("@scope/pkg");
    expect(out.split("\n").length).toBe(4);
    expect(out).toContain("const a = 1;");
  });

  it("REGRESSION: a `/*` inside a line comment must NOT swallow the following real imports (the comment-adjacent-import bug)", () => {
    const src = [
      "// singleton — `@/lib/*` is no longer reachable from the connector package",
      'import { registerGmailConnector } from "@scope/gmail-connector";',
      'import { registerResendConnector } from "@scope/resend-connector";',
      "/** real jsdoc */",
      "export const x = 1;",
    ].join("\n");
    const out = stripComments(src);
    expect(out).toContain('"@scope/gmail-connector"');
    expect(out).toContain('"@scope/resend-connector"');
    expect(out).not.toContain("@/lib/*");
    expect(out).not.toContain("real jsdoc");
  });

  it("REGRESSION: a comment naming a placeholder import directly above a REAL loader map leaves the real imports counted", () => {
    const src = [
      "// Once a real page exists, replace the placeholder with",
      '// `() => import("@scope/<slug>/setup-page")`.',
      "const LOADERS = {",
      '  "openai-connector": () => import("@scope/openai-connector/setup-page"),',
      "};",
    ].join("\n");
    const out = stripComments(src);
    expect(out).toContain('"@scope/openai-connector/setup-page"');
    expect(out).not.toContain("<slug>");
  });

  it("REGRESSION: `//` inside a string literal must NOT swallow the rest of the line", () => {
    const out = stripComments('const u = "//cdn.test/x"; register("@scope/real-connector");\n');
    expect(out).toContain('"//cdn.test/x"');
    expect(out).toContain('"@scope/real-connector"');
  });

  it("REGRESSION: `/*` inside a string (glob pattern) must NOT open a block comment", () => {
    const src = 'const g = ["src/**/*.ts", "x"];\nconst real = "@scope/real-agent";\nconst h = "end/*";\n';
    const out = stripComments(src);
    expect(out).toContain('"src/**/*.ts"');
    expect(out).toContain('"@scope/real-agent"');
  });

  it("preserves string and template contents (the gates scan literals)", () => {
    const src = 'const a = "@scope/pkg:capability";\nconst b = `extensions/${scope}/${name}/SKILL.md`;\n';
    const out = stripComments(src);
    expect(out).toContain('"@scope/pkg:capability"');
    expect(out).toContain("extensions/${scope}/${name}/SKILL.md");
  });

  it("preserves https:// URLs inside strings and strips them inside comments", () => {
    const out = stripComments('const u = "https://x.test/a"; // see https://docs.test/@scope/pkg\n');
    expect(out).toContain('"https://x.test/a"');
    expect(out).not.toContain("docs.test");
  });

  it("preserves protocol URLs in un-modeled JSX TEXT (the `:` guard) so adjacent references survive", () => {
    const out = stripComments("<div>see https://docs.test and @scope/jsx-connector</div>\n");
    expect(out).toContain("https://docs.test");
    expect(out).toContain("@scope/jsx-connector");
  });

  it("still strips a comment that follows a colon with whitespace", () => {
    const out = stripComments("const x = cond ? a : // pick @scope/pkg\n  b;\n");
    expect(out).not.toContain("pick");
    expect(out).toContain("b;");
  });

  it("handles template-literal interpolation with nested braces and a nested template", () => {
    const src = "const t = `a ${obj({ k: `inner ${x}` })} b`; // tail comment\nconst keep = 1;\n";
    const out = stripComments(src);
    expect(out).toContain("`a ${obj({ k: `inner ${x}` })} b`");
    expect(out).not.toContain("tail comment");
    expect(out).toContain("const keep = 1;");
  });

  it("strips comments inside template interpolations without eating the template tail", () => {
    const src = "const t = `x ${a /* gone */ + b} y`;\n";
    const out = stripComments(src);
    expect(out).not.toContain("gone");
    expect(out).toContain("} y`");
  });

  it("does not treat a regex literal containing escaped slashes as a comment", () => {
    const src = 'const re = /a\\/\\/b/; const keep = "@scope/kept-connector";\n';
    const out = stripComments(src);
    expect(out).toContain('"@scope/kept-connector"');
  });

  it("treats `/` after an identifier as division, not a regex start", () => {
    const out = stripComments("const r = a / b / c; // comment\n");
    expect(out).toContain("a / b / c;");
    expect(out).not.toContain("comment");
  });

  it("handles escaped quotes inside strings", () => {
    const out = stripComments('const s = "he said \\"hi\\" // not a comment"; const k = 1;\n');
    expect(out).toContain('\\"hi\\" // not a comment');
    expect(out).toContain("const k = 1;");
  });

  it("an unterminated block comment swallows to EOF without throwing", () => {
    const out = stripComments("const a = 1;\n/* open forever\nconst b = 2;");
    expect(out).toContain("const a = 1;");
    expect(out).not.toContain("const b = 2;");
  });
});
