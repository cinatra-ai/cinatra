/**
 * Markdown link extraction and bundle-relative resolution.
 *
 * Two internal forms per the OKF 0.1 spec: absolute (bundle-root `/...`) and
 * standard relative paths. Broken links are tolerated by design — a link
 * whose target does not exist may simply be not-yet-written knowledge — so
 * resolution never throws; consumers surface broken links as warnings.
 */
import * as path from "node:path";

import type { MemoryLink } from "./types.ts";

// Bounded quantifiers + mutually-exclusive character classes: concept bodies
// are untrusted input, so the scan must stay linear on adversarial strings
// (no polynomial backtracking). Real link text/targets/titles fit well within
// these bounds; anything longer is not a link worth resolving.
const LINK_PATTERN =
  /!?\[([^\]\r\n]{0,512})\]\(([^()\s]{1,1024})(?:[ \t]{1,8}"[^"\r\n]{0,512}")?\)/g;
const SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

function stripTarget(raw: string): string {
  let target = raw;
  if (target.startsWith("<") && target.endsWith(">")) {
    target = target.slice(1, -1);
  }
  const hash = target.indexOf("#");
  if (hash !== -1) target = target.slice(0, hash);
  return target;
}

/**
 * Percent-decode a link target for path resolution. Markdown link targets
 * are URL-shaped, so `%20`-style escapes (including the escapes the index
 * generator emits) must decode back to the on-disk path bytes; a malformed
 * escape sequence keeps the raw text (a literal `%` is a valid path byte).
 */
function decodeTarget(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

/**
 * Extract every markdown link from a concept body and resolve internal
 * targets against the concept's own bundle-relative path.
 */
export function extractMemoryLinks(
  conceptPath: string,
  body: string,
): MemoryLink[] {
  const links: MemoryLink[] = [];
  for (const match of body.matchAll(LINK_PATTERN)) {
    const text = match[1] ?? "";
    const raw = match[2] ?? "";
    const target = stripTarget(raw);
    if (target === "") continue;
    if (SCHEME_PATTERN.test(target) || target.startsWith("//")) {
      links.push({ text, target: raw, kind: "external" });
      continue;
    }
    if (target.startsWith("/")) {
      const resolved = path.posix.normalize(decodeTarget(target.slice(1)));
      links.push({
        text,
        target: raw,
        kind: "absolute",
        // An encoded leading slash (e.g. /%2Ffoo.md) decodes to an absolute
        // path with no in-bundle target — treat it like an escaping link.
        ...(resolved.startsWith("../") ||
        resolved === ".." ||
        path.posix.isAbsolute(resolved)
          ? {}
          : { resolvedPath: resolved }),
      });
      continue;
    }
    const dir = path.posix.dirname(conceptPath);
    const resolved = path.posix.normalize(
      path.posix.join(dir === "." ? "" : dir, decodeTarget(target)),
    );
    links.push({
      text,
      target: raw,
      kind: "relative",
      // A relative link that escapes the bundle root has no in-bundle target.
      ...(resolved.startsWith("../") || resolved === ".."
        ? {}
        : { resolvedPath: resolved }),
    });
  }
  return links;
}
