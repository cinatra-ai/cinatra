// SPDX license detection.
// Permissive (pass): MIT, Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, Unlicense, 0BSD
// Copyleft (warn + acknowledge): GPL-2.0, GPL-3.0, AGPL-3.0, LGPL-2.1, LGPL-3.0, MPL-2.0
//   plus prefix variants: GPL-*, AGPL-*, LGPL-*, MPL-2.0*
// Unknown / missing / ambiguous / multi-license → reject
// No legal inference. No per-file scanning. Sources checked in this order:
//   1. package.json#license field
//   2. LICENSE / LICENSE.md / COPYING with SPDX-License-Identifier header
//   3. .spdx manifest with SPDX-License-Identifier header

import { readFile } from "node:fs/promises";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// LicenseDetectionResult — discriminated union for the three tiers.
// ---------------------------------------------------------------------------

export type LicenseDetectionResult =
  | { tier: "permissive"; spdxId: string }
  | { tier: "copyleft"; spdxId: string }
  | { tier: "reject"; reason: "unknown" | "missing" | "ambiguous" | "multi-license" };

// ---------------------------------------------------------------------------
// Static maps — zero deps; covers all 13 locked SPDX IDs.
// ---------------------------------------------------------------------------

const PERMISSIVE = new Set<string>([
  "MIT",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "Unlicense",
  "0BSD",
]);

const COPYLEFT_EXACT = new Set<string>([
  "GPL-2.0",
  "GPL-3.0",
  "AGPL-3.0",
  "LGPL-2.1",
  "LGPL-3.0",
  "MPL-2.0",
]);

// Prefix-match for variant suffixes like -only / -or-later (e.g. GPL-3.0-only)
const COPYLEFT_PREFIXES = ["GPL-", "AGPL-", "LGPL-"];

// Recognizes multi-license SPDX expressions (AND / OR / WITH / parentheses).
// Anything matching → tier: reject / reason: multi-license.
const MULTI_LICENSE_RE = /\b(AND|OR|WITH)\b|\(|\)/;

// SPDX-License-Identifier header line in a text file.
const SPDX_HEADER_RE = /^SPDX-License-Identifier:\s*(.+)$/m;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function classify(raw: string): LicenseDetectionResult {
  const spdxId = raw.trim();
  if (MULTI_LICENSE_RE.test(spdxId)) {
    return { tier: "reject", reason: "multi-license" };
  }
  if (PERMISSIVE.has(spdxId)) {
    return { tier: "permissive", spdxId };
  }
  if (COPYLEFT_EXACT.has(spdxId)) {
    return { tier: "copyleft", spdxId };
  }
  // Prefix match: GPL-3.0-only, LGPL-2.1-or-later, etc.
  for (const prefix of COPYLEFT_PREFIXES) {
    if (spdxId.startsWith(prefix)) {
      return { tier: "copyleft", spdxId };
    }
  }
  // MPL-2.0+ variant (e.g. MPL-2.0-no-copyleft-exception)
  if (/^MPL-2\.0/.test(spdxId)) {
    return { tier: "copyleft", spdxId };
  }
  return { tier: "reject", reason: "unknown" };
}

async function tryReadFile(filePath: string): Promise<string | null> {
  try {
    // Read the file; truncate to first 10KB to guard against large LICENSE files.
    const content = await readFile(filePath, "utf8");
    return content.length > 10 * 1024 ? content.slice(0, 10 * 1024) : content;
  } catch {
    return null;
  }
}

function extractSpdxFromContent(content: string): LicenseDetectionResult | null {
  const match = SPDX_HEADER_RE.exec(content);
  if (!match) return null;
  return classify(match[1]);
}

// ---------------------------------------------------------------------------
// detectSpdxLicense — main export
// ---------------------------------------------------------------------------

/**
 * Conservative SPDX license detection for an unpacked package directory.
 *
 * Sources checked in order (first hit wins):
 *   1. package.json#license
 *   2. LICENSE / LICENSE.md / COPYING with SPDX-License-Identifier header
 *   3. .spdx manifest with SPDX-License-Identifier header
 *
 * Returns LicenseDetectionResult discriminated by tier:
 *   - permissive: safe to proceed
 *   - copyleft: requires explicit acknowledgement before publish
 *   - reject: missing / unknown / ambiguous / multi-license — blocks publish
 */
export async function detectSpdxLicense(packageDir: string): Promise<LicenseDetectionResult> {
  // ---------------------------------------------------------------------------
  // Source 1: package.json#license
  // ---------------------------------------------------------------------------
  const packageJsonContent = await tryReadFile(join(packageDir, "package.json"));
  if (packageJsonContent) {
    try {
      const parsed = JSON.parse(packageJsonContent) as { license?: unknown };
      if (typeof parsed.license === "string" && parsed.license.length > 0) {
        return classify(parsed.license);
      }
      // Deprecated object form { type: "MIT" } — treat as ambiguous (not a string SPDX ID).
      if (parsed.license !== undefined && parsed.license !== null && typeof parsed.license === "object") {
        return { tier: "reject", reason: "ambiguous" };
      }
      // license field absent or null — fall through to file sources.
    } catch {
      // Malformed package.json — fall through.
    }
  }

  // ---------------------------------------------------------------------------
  // Source 2: LICENSE / LICENSE.md / COPYING with SPDX header
  // ---------------------------------------------------------------------------
  for (const fileName of ["LICENSE", "LICENSE.md", "COPYING"]) {
    const content = await tryReadFile(join(packageDir, fileName));
    if (content) {
      const result = extractSpdxFromContent(content);
      if (result) return result;
      // File present but no SPDX header — continue to next candidate.
    }
  }

  // ---------------------------------------------------------------------------
  // Source 3: .spdx manifest
  // ---------------------------------------------------------------------------
  const spdxContent = await tryReadFile(join(packageDir, ".spdx"));
  if (spdxContent) {
    const result = extractSpdxFromContent(spdxContent);
    if (result) return result;
  }

  // No source found.
  return { tier: "reject", reason: "missing" };
}

// ---------------------------------------------------------------------------
// LicenseDetectionRejectedError — thrown when license detection returns reject tier.
// Exported so wiring call sites (mcp/handlers.ts, import-agent-core.ts) can
// catch this specifically without re-running detection.
// ---------------------------------------------------------------------------

export class LicenseDetectionRejectedError extends Error {
  readonly code = "LICENSE_DETECTION_REJECTED";
  constructor(public readonly reason: "unknown" | "missing" | "ambiguous" | "multi-license") {
    super(
      `License could not be determined (${reason}). Clarify the license upstream or use a different package.`,
    );
    this.name = "LicenseDetectionRejectedError";
  }
}

// ---------------------------------------------------------------------------
// LicenseAcknowledgementRequiredError — thrown when copyleft tier detected but
// the caller has not yet passed licenseAcknowledged: true.
// ---------------------------------------------------------------------------

export class LicenseAcknowledgementRequiredError extends Error {
  readonly code = "LICENSE_ACKNOWLEDGEMENT_REQUIRED";
  constructor(public readonly spdxId: string) {
    super(
      `Copyleft license ${spdxId} requires explicit acknowledgement before publishing.`,
    );
    this.name = "LicenseAcknowledgementRequiredError";
  }
}
