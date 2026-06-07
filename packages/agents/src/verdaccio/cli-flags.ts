import "server-only";

// Per-CLI-call npm flag builder.
//
// Cinatra never writes to ~/.npmrc or project .npmrc — every npm/pnpm
// invocation includes --registry= and --//<host>/:_authToken= explicitly.
// Caller passes the resolved VerdaccioConfig, so there is no global-state
// lookup.
//
// This helper centralizes registry flag construction so every spawn site can
// use one canonical implementation.

/**
 * Extract the host (with port, if present) from a registry URL using
 * `new URL(...).host`. Built-in URL parsing is the don't-hand-roll choice
 * for npm CLI flag construction. Throws on malformed URL — let the error
 * propagate so the misconfiguration surfaces at the spawn site rather than
 * producing a silently-wrong flag.
 */
export function extractHost(url: string): string {
  return new URL(url).host;
}

/**
 * Build the `--registry=<url>` + `--//<host>/:_authToken=<token>` flag pair
 * from an explicitly-passed `VerdaccioConfig`. Caller MUST splice the
 * returned array into its `execFile`/`execFileAsync` argv.
 *
 * Throws when `config.token` is empty or null — an unauthenticated registry
 * call would silently fail at the registry boundary with an opaque 401,
 * masking the upstream misconfiguration. Accepts `token: string | null` so
 * callers can pass `VerdaccioConfig` directly (its `token` field is
 * `string | null` to model the metadata-row absence case at boot); the
 * helper enforces non-empty at the call boundary.
 *
 * Token redaction (`redactToken` in client.ts) MUST still be applied to any
 * logged command line — this helper produces the cleartext flags; logging is
 * the caller's responsibility.
 */
export function buildRegistryAuthArgs(config: {
  registryUrl: string;
  token: string | null;
}): string[] {
  if (config.token === null || config.token.length === 0) {
    throw new Error(
      "VerdaccioConfig.token is empty — registry call would be unauthenticated.",
    );
  }
  const host = extractHost(config.registryUrl);
  return [
    `--registry=${config.registryUrl}`,
    `--//${host}/:_authToken=${config.token}`,
  ];
}
