/**
 * Vendor byline resolution for the Installed extensions page (cinatra#948
 * reopen, gap 3).
 *
 * §VI renders "{Type} by {Vendor}" with the HUMAN vendor name in ink. The
 * hydration chain is manifest/registry metadata only:
 *
 *   1. the extension's SELF-DECLARED vendor identity name (`cinatra.vendor`
 *      from the generated static extension manifest — the value the
 *      marketplace publish gate verified);
 *   2. the registry summary's npm `author` (packument manifest metadata);
 *   3. null — the byline renders the bare "{Type}" with no "by".
 *
 * The raw npm scope segment NEVER renders as the vendor (the shipped
 * `vendorFor` fell back to it — "Agent by cinatra-ai" — which the reopen
 * live-proved against §VI L894–898).
 */
export function resolveInstalledVendorName(input: {
  /** `cinatra.vendor.name` from the generated static extension manifest. */
  manifestVendorName: string | null | undefined;
  /** Registry summary `author` (npm packument author, already length-capped). */
  author: string | null | undefined;
}): string | null {
  const manifest = normalize(input.manifestVendorName);
  if (manifest) return manifest;
  return normalize(input.author);
}

function normalize(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
