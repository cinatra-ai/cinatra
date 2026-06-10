// Shared lexical comment stripper for the audit gates.
//
// The previous per-gate implementation was a regex pair:
//
//   src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1")
//
// which is NOT comment-aware — it matched comment DELIMITERS anywhere in the
// raw text, including inside other comments and inside string literals. Two
// concrete failure classes (both verified against this tree):
//
//   1. A `/*` inside a LINE comment (e.g. a doc note mentioning `@/lib/*`)
//      opened a bogus "block comment" that swallowed every real line — imports
//      included — until the next `*/` anywhere in the file. This hid the whole
//      static import cluster of `src/lib/register-transport-connectors.ts`
//      (12 gate-counted occurrences) and the live setup-page loader map of
//      `src/lib/connector-setup-pages.ts` (18 gate-counted occurrences) from
//      the extension-coupling scanners.
//   2. A `//` inside a STRING literal (protocol-relative URL, `a//b` path)
//      swallowed the rest of that line, including real references after it.
//
// This module replaces the regexes with a single-pass lexer that tracks the
// real lexical context: line comments, block comments, single/double-quoted
// strings, template literals (with nested `${ ... }` interpolation), and a
// conservative regex-literal heuristic. Comments are removed; everything else
// — string and template contents included — is preserved verbatim, because the
// coupling gates deliberately scan string/JSX/prompt literals. Newlines inside
// comments are preserved so line structure (and any future line attribution)
// survives.
//
// Known, accepted limitations:
//   - regex-literal detection is heuristic (a `/` opens a regex only after an
//     operator/keyword position); an ambiguous regex containing `//` or `/*`
//     could still confuse the lexer (fails toward OVER-counting);
//   - JSX TEXT is not modeled (that needs a real JSX parser). To keep the
//     dominant case — URLs in JSX text / doc strings — intact, a `//` that
//     immediately follows `:` is NOT treated as a comment opener (`https://x`
//     survives; a real comment after a colon always has whitespace before
//     `//`, so it still strips). KNOWN RESIDUAL HIDING CLASS: a bare non-URL
//     `//` inside JSX text still drops the rest of that line, so a
//     named-extension reference appearing in JSX text AFTER a bare `//`
//     would be UNDER-counted. No such case exists in the tree today (the
//     recomputed baseline shows zero decreases vs the old scanner), and the
//     class is deliberately deferred to a JSX-aware lexer — tracked on
//     cinatra-ai/cinatra#26 as an explicit non-silent deferral.

// Characters after which a `/` starts a REGEX literal (not division).
const REGEX_PRECEDERS = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "/", "%", "<", ">", "^", "~",
]);
// Keywords after which a `/` starts a regex literal even though the preceding
// significant character is alphanumeric (`return /x/`, `case /x/`, ...).
const REGEX_PRECEDER_KEYWORDS = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "case", "do", "else", "yield", "await", "throw",
]);

function isRegexPosition(out) {
  // Find the last non-whitespace character emitted so far.
  let i = out.length - 1;
  while (i >= 0 && /\s/.test(out[i])) i--;
  if (i < 0) return true; // start of input
  const c = out[i];
  if (REGEX_PRECEDERS.has(c)) return true;
  if (/[A-Za-z_$]/.test(c)) {
    // Pull the trailing identifier and check the keyword set.
    let j = i;
    while (j >= 0 && /[A-Za-z0-9_$]/.test(out[j])) j--;
    return REGEX_PRECEDER_KEYWORDS.has(out.slice(j + 1, i + 1));
  }
  return false;
}

/**
 * Strip line comments and block comments from JS/TS/JSX source while
 * PRESERVING all string/template-literal contents and line structure.
 * Single pass, lexical-context aware.
 */
export function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  // Lexical context stack. Entries: "code" (top-level or `${}` interpolation
  // body) and "tpl" (template-literal text). `braces` carries the curly-brace
  // depth for each "code" entry so a `}` that closes an interpolation can be
  // told apart from a `}` that closes an object/block inside it.
  const stack = ["code"];
  const braces = [0];

  while (i < n) {
    const top = stack[stack.length - 1];
    const c = src[i];
    const d = i + 1 < n ? src[i + 1] : "";

    if (top === "code") {
      if (c === "/" && d === "/" && (i === 0 || src[i - 1] !== ":")) {
        // Line comment — drop to (but keep) the newline. The `:` guard keeps
        // protocol URLs in un-modeled JSX text intact (`https://...`); a real
        // comment after a colon always has whitespace before the slashes.
        while (i < n && src[i] !== "\n") i++;
        continue;
      }
      if (c === "/" && d === "*") {
        // Block comment — drop to the matching close, keep newlines, emit one
        // space so adjacent tokens cannot fuse (`a/* */b` -> `a b`).
        i += 2;
        while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
          if (src[i] === "\n") out += "\n";
          i++;
        }
        i += 2; // past "*/" (or past EOF on an unterminated comment)
        out += " ";
        continue;
      }
      if (c === "'" || c === '"') {
        // String literal — copy verbatim, honoring escapes. An unescaped
        // newline ends the (malformed) literal so a typo cannot swallow the file.
        out += c;
        i++;
        while (i < n) {
          const s = src[i];
          out += s;
          i++;
          if (s === "\\" && i < n) {
            out += src[i];
            i++;
            continue;
          }
          if (s === c || s === "\n") break;
        }
        continue;
      }
      if (c === "`") {
        out += c;
        i++;
        stack.push("tpl");
        continue;
      }
      if (c === "/" && isRegexPosition(out)) {
        // Regex literal — copy verbatim through the unescaped closing `/`,
        // honoring character classes (where `/` needs no escape).
        out += c;
        i++;
        let inClass = false;
        while (i < n) {
          const s = src[i];
          out += s;
          i++;
          if (s === "\\" && i < n) {
            out += src[i];
            i++;
            continue;
          }
          if (s === "[") inClass = true;
          else if (s === "]") inClass = false;
          else if (s === "/" && !inClass) break;
          else if (s === "\n") break; // malformed — bail out of the literal
        }
        continue;
      }
      if (c === "{") {
        braces[braces.length - 1]++;
        out += c;
        i++;
        continue;
      }
      if (c === "}") {
        if (braces[braces.length - 1] === 0 && stack.length > 1 && stack[stack.length - 2] === "tpl") {
          // Closes a `${ ... }` interpolation — back to template text.
          stack.pop();
          braces.pop();
        } else if (braces[braces.length - 1] > 0) {
          braces[braces.length - 1]--;
        }
        out += c;
        i++;
        continue;
      }
      out += c;
      i++;
      continue;
    }

    // top === "tpl" — template-literal text: copy verbatim.
    if (c === "\\" && d !== "") {
      out += c + d;
      i += 2;
      continue;
    }
    if (c === "`") {
      out += c;
      i++;
      stack.pop();
      continue;
    }
    if (c === "$" && d === "{") {
      out += "${";
      i += 2;
      stack.push("code");
      braces.push(0);
      continue;
    }
    out += c;
    i++;
  }

  return out;
}
