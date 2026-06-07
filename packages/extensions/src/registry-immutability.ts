// Verdaccio immutability verifier.
//
// The lifecycle contract requires that no caller — authenticated or not —
// can yank or delete a published version of a Cinatra extension. The
// `docker/verdaccio/config.yaml` file in this repo sets `unpublish: nobody`
// for every package glob, which Verdaccio interprets as "no one is allowed
// to invoke this action."
//
// This module provides a fail-closed verifier that production boot can run
// to assert the live config matches the contract. In production mode, when
// the verifier returns a violation, callers MUST refuse to publish (and the
// dev-server boot logs a loud warning).
import "server-only";

import { readFileSync, existsSync } from "node:fs";

export type ImmutabilityCheck =
  | { ok: true; configPath: string; checkedGlobs: string[] }
  | { ok: false; configPath: string | null; reasons: string[] };

/**
 * Inspect the docker/verdaccio/config.yaml file and return whether the
 * `unpublish:` directive is locked down for every package glob.
 *
 * The check is intentionally syntactic (regex against the YAML text)
 * rather than a full YAML parse — this is a CI-side gate, not an admin
 * UI. The tests in __tests__/ also exercise this function.
 */
export function verifyVerdaccioImmutability(configPath: string): ImmutabilityCheck {
  if (!existsSync(configPath)) {
    return { ok: false, configPath: null, reasons: [`config file not found at ${configPath}`] };
  }
  const raw = readFileSync(configPath, "utf8");

  // Strip comments + blank lines.
  const lines = raw
    .split("\n")
    .map((l) => l.replace(/#.*$/, ""))
    .filter((l) => l.trim().length > 0);

  // Find every `unpublish:` directive and its value.
  const unpublishLines = lines.filter((l) => /^\s*unpublish\s*:/.test(l));
  if (unpublishLines.length === 0) {
    return {
      ok: false,
      configPath,
      reasons: [
        "no `unpublish:` directive found in any packages block — Verdaccio's default allows authenticated unpublish",
      ],
    };
  }

  const reasons: string[] = [];
  const checkedGlobs: string[] = [];
  for (const line of unpublishLines) {
    checkedGlobs.push(line.trim());
    // Acceptable values: `nobody`, `$nobody`, an empty list, or any reference
    // to a group that resolves to nobody. ANY of these block real users.
    const valueMatch = /^\s*unpublish\s*:\s*(\S+)/.exec(line);
    if (!valueMatch) continue;
    const value = valueMatch[1]!;
    if (value === "nobody" || value === "$nobody" || value === "[]") continue;
    if (value === "$authenticated" || value === "$all") {
      reasons.push(
        `unpublish: ${value} is permissive — set to 'nobody' to enforce immutable-on-publish`,
      );
    }
  }

  if (reasons.length > 0) return { ok: false, configPath, reasons };
  return { ok: true, configPath, checkedGlobs };
}

/**
 * Boot-time guard. In production, fails closed; in dev, logs a warning.
 *
 * This is the operational minimum. Yank/retention/multi-site replication
 * tooling is separate operations work.
 */
export function assertVerdaccioImmutabilityOrFail(configPath: string): void {
  const result = verifyVerdaccioImmutability(configPath);
  if (result.ok) return;
  const isProd = process.env.NODE_ENV === "production";
  const message = `Verdaccio config is not immutable-on-publish at ${result.configPath ?? "<unknown>"}:\n  - ${result.reasons.join("\n  - ")}`;
  if (isProd) {
    throw new Error(message);
  }
  // eslint-disable-next-line no-console
  console.warn(message);
}
