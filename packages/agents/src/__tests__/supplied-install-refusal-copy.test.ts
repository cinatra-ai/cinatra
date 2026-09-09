/**
 * THE ADMIN-FACING REFUSAL a supplied connector install produces
 * (cinatra#3204 — the Upload screen's refusal copy).
 *
 * WHAT THIS PINS, and why it is a test rather than a review note.
 *
 * A connector package that ships no `cinatra/config.json` is refused, correctly,
 * deep inside the install chain — and the chain's own words are DEVELOPER words:
 * the SDK validator names the file and the internal issue that closed the
 * absence rule, the runtime activator prefixes its own failure token, and the
 * dispatcher appends what it did to the placeholder row. Composed, that is a
 * paragraph of diagnostics; it reached the admin verbatim through the toast
 * surface, where its LENGTH — not its content — pushed the toast off the top of
 * the viewport.
 *
 * So the raw message is reproduced HERE from the real chain (the SDK's own
 * refusal, wrapped exactly as `extension-runtime-activate` and the dispatcher
 * wrap it) rather than pasted as a literal: if any link in that chain rewords
 * itself, this suite fails instead of silently testing a message nobody throws.
 * The assertions then hold the ONE thing the admin is owed — one short sentence,
 * in product words, naming what the package lacks and what to do about it.
 */
import { describe, expect, it } from "vitest";
import {
  parseConnectorAccessConfig,
  resolveAbsentConnectorAccessConfig,
} from "@cinatra-ai/sdk-extensions/access-config";

import {
  CONNECTOR_REFUSAL_MAX_LENGTH,
  adminFacingSuppliedInstallRefusal,
} from "../supplied-install-refusal-copy";

const PACKAGE = "@acme/upload-walk-connector";

function thrownMessage(run: () => unknown): string {
  try {
    run();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  throw new Error("expected the access-declaration read to refuse, but it returned");
}

/**
 * The message the operator actually received: the SDK refusal, wrapped by
 * `extension-runtime-activate`'s supplied-row reason token and then by the
 * dispatcher's non-finalized-row sentence (packages/extensions/src/index.ts).
 * This is the shape read off a running instance's toast surface.
 */
function rawChainMessage(inner: string): string {
  const reason = `supplied-install-failed:${inner}`;
  return (
    `install of ${PACKAGE} did not finalize the real-integrity pipeline ` +
    `(${reason}) — the package is not anchorable; the placeholder ` +
    `install row was rolled back so a re-install re-runs the pipeline.`
  );
}

const ABSENT_CONFIG_RAW = rawChainMessage(
  thrownMessage(() =>
    resolveAbsentConnectorAccessConfig({ packageName: PACKAGE, surface: "install" }),
  ),
);

const INVALID_CONFIG_RAW = rawChainMessage(
  thrownMessage(() =>
    parseConnectorAccessConfig(
      { formatVersion: 1, access: { scope: { default: "everyone" } } },
      { packageName: PACKAGE },
    ),
  ),
);

/** Developer vocabulary that must never reach the toast surface. */
const INTERNAL_TOKEN =
  /pipeline-threw|supplied-install-failed|\[connector-access-config\]|cinatra\/config\.json/;
const ISSUE_REFERENCE = /cinatra#\d+/;
const ROLLBACK_PROSE = /roll(?:ed|s|ing)?[ -]?back/i;

describe("the raw install chain really does speak in developer diagnostics", () => {
  it("carries an internal failure token, an internal issue reference and the rollback detail", () => {
    expect(ABSENT_CONFIG_RAW).toMatch(INTERNAL_TOKEN);
    expect(ABSENT_CONFIG_RAW).toMatch(ISSUE_REFERENCE);
    expect(ABSENT_CONFIG_RAW).toMatch(ROLLBACK_PROSE);
    expect(ABSENT_CONFIG_RAW.length).toBeGreaterThan(CONNECTOR_REFUSAL_MAX_LENGTH);
  });
});

describe("the admin-facing refusal is one short sentence in product words", () => {
  it("answers the absent-configuration refusal with what the package lacks and what to do", () => {
    const refusal = adminFacingSuppliedInstallRefusal(ABSENT_CONFIG_RAW);
    expect(refusal).not.toBeNull();
    const message = refusal as string;

    expect(message).not.toMatch(INTERNAL_TOKEN);
    expect(message).not.toMatch(ISSUE_REFERENCE);
    expect(message).not.toMatch(ROLLBACK_PROSE);
    expect(message.length).toBeLessThan(CONNECTOR_REFUSAL_MAX_LENGTH);

    // ONE sentence: exactly one terminator, and it is the last character.
    expect(message.match(/[.!?]/g) ?? []).toHaveLength(1);
    expect(message.trim().endsWith(".")).toBe(true);

    // What it lacks, and what to do about it — in the product's own words.
    expect(message).toMatch(/configuration/i);
    expect(message).toMatch(/access scope/i);
  });

  it("answers an INVALID configuration just as shortly", () => {
    const refusal = adminFacingSuppliedInstallRefusal(INVALID_CONFIG_RAW);
    expect(refusal).not.toBeNull();
    const message = refusal as string;

    expect(message).not.toMatch(INTERNAL_TOKEN);
    expect(message).not.toMatch(ISSUE_REFERENCE);
    expect(message).not.toMatch(ROLLBACK_PROSE);
    expect(message.length).toBeLessThan(CONNECTOR_REFUSAL_MAX_LENGTH);
    expect(message).toMatch(/access scope/i);
  });

  it("leaves every other refusal in the words of whatever refused it", () => {
    expect(
      adminFacingSuppliedInstallRefusal(
        'Invalid archive: "workflow" is a retired extension kind and cannot be installed.',
      ),
    ).toBeNull();
    expect(adminFacingSuppliedInstallRefusal("")).toBeNull();
  });
});
