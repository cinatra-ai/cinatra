/**
 * Deterministic content hash over a catalog skill's `SKILL.md` + its bundled
 * directory.
 *
 * The hash is the drift signal: any change to SKILL.md bytes, any bundled
 * file's bytes, OR the bundled file SET (add/remove/rename) MUST produce a
 * different hash so the sync engine creates a NEW immutable Anthropic version
 * (`POST /v1/skills/{id}/versions`) — never mutating or deleting an existing
 * one.
 *
 * Pure: no fs, no network. The caller supplies already-read raw bytes so this
 * module is trivially unit-testable and has zero `src/lib` import (correct
 * dependency direction; standing invariant — this lives in
 * `@cinatra-ai/llm`).
 *
 * Canonicalization:
 * - Bundled file paths are POSIX-normalized (`\` → `/`, collapse `./`).
 * - Absolute paths and any `..` traversal segment are REJECTED (throw) — a
 *   bundled file must be strictly under the skill's source directory.
 * - Duplicate normalized paths are REJECTED (throw) — non-deterministic input.
 * - Entries are sorted bytewise by normalized path before framing.
 * - RAW bytes are hashed (no text decode, no CRLF rewrite). Directories /
 *   empty dirs are not entries (the caller passes files only; symlinks are
 *   excluded by the caller's walk).
 * - Length-prefixed, NUL-delimited framing makes the path/byte boundaries
 *   unambiguous so two different file sets can never frame to the same bytes.
 */

import { createHash } from "node:crypto";

export type SkillBundledFile = {
  /** Path relative to the skill's source directory (POSIX or native). */
  relPath: string;
  /** Raw file bytes. */
  bytes: Buffer;
};

/**
 * Normalize a relative bundled-file path to POSIX form and reject anything
 * that escapes the skill source directory or is non-deterministic.
 */
export function normalizeBundledRelPath(relPath: string): string {
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw new Error(`[anthropic-skill-content-hash] empty bundled file path`);
  }
  const posix = relPath.replaceAll("\\", "/");
  if (posix.startsWith("/")) {
    throw new Error(
      `[anthropic-skill-content-hash] absolute bundled path rejected: ${relPath}`,
    );
  }
  const segments = posix.split("/").filter((s) => s.length > 0 && s !== ".");
  if (segments.some((s) => s === "..")) {
    throw new Error(
      `[anthropic-skill-content-hash] path traversal ('..') rejected: ${relPath}`,
    );
  }
  if (segments.length === 0) {
    throw new Error(
      `[anthropic-skill-content-hash] bundled path resolves to empty: ${relPath}`,
    );
  }
  return segments.join("/");
}

function frame(hash: ReturnType<typeof createHash>, label: string, value: Buffer) {
  // label\0<len>\0<bytes> — unambiguous boundaries.
  hash.update(label);
  hash.update("\0");
  hash.update(String(value.length));
  hash.update("\0");
  hash.update(value);
}

/**
 * Compute the deterministic SHA-256 hex digest over the SKILL.md body and the
 * bundled file set. Pure + order-independent in input (sorted internally).
 *
 * @throws on absolute / `..` / duplicate normalized bundled paths.
 */
export function computeSkillContentHash(
  skillMd: Buffer,
  bundledFiles: SkillBundledFile[],
): string {
  const normalized = bundledFiles.map((f) => ({
    relPath: normalizeBundledRelPath(f.relPath),
    bytes: f.bytes,
  }));

  const seen = new Set<string>();
  for (const f of normalized) {
    if (seen.has(f.relPath)) {
      throw new Error(
        `[anthropic-skill-content-hash] duplicate normalized bundled path: ${f.relPath}`,
      );
    }
    seen.add(f.relPath);
  }

  normalized.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));

  const hash = createHash("sha256");
  // Version tag so a future framing change is itself a drift (defensive).
  hash.update("anthropic-skill-content-hash:v1\0");
  frame(hash, "SKILLMD", skillMd);
  hash.update(String(normalized.length));
  hash.update("\0");
  for (const f of normalized) {
    frame(hash, "PATH", Buffer.from(f.relPath, "utf8"));
    frame(hash, "FILE", f.bytes);
  }
  return hash.digest("hex");
}
