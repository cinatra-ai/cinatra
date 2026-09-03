// ---------------------------------------------------------------------------
// received-package-digest.ts — the server half of the D2 attestation
// (cinatra#3204).
//
// WHY THIS EXISTS. The Upload screen computes a content digest in the browser
// and sends it with the archive. A digest that arrives alongside the bytes it
// describes, and is then written down unchecked, attests NOTHING: the sender
// chose both halves, and a server action is reachable by anything that can
// speak to it, not only by the screen. Worse, the screen does not send the tree
// it digested for the preview — it sends the canonical repack — so a recorded
// preview digest would describe a file set the server never had.
//
// So the server recomputes the digest over the archive IN ITS OWN HANDS and
// refuses the import when the two disagree. What ends up on the canonical row
// is a value this process computed from the bytes it installed.
// ---------------------------------------------------------------------------

import { computeExtensionTreeDigest } from "@cinatra-ai/extensions/extension-package-digest";
import { readZipFiles } from "./zip-helpers";

/**
 * Recompute the tree digest over the archive that arrived, and refuse when it
 * is not the digest the request stated.
 *
 * Returns the RECOMPUTED value, never the stated one — a caller that records
 * the return value cannot accidentally record a claim.
 */
export async function verifyReceivedArchiveDigest(
  zipBase64: string,
  statedDigest: string,
): Promise<string> {
  let files: Map<string, string>;
  try {
    files = readZipFiles(Buffer.from(zipBase64, "base64"));
  } catch (err) {
    throw new Error(
      `The uploaded archive could not be read to verify its content digest: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const te = new TextEncoder();
  const recomputed = await computeExtensionTreeDigest(
    [...files].map(([name, content]) => [name, te.encode(content)] as const),
  );
  if (recomputed !== statedDigest) {
    throw new Error(
      "The uploaded package does not match the one that was previewed: the request states the content " +
        `digest ${statedDigest}, and the archive that arrived digests to ${recomputed}. Nothing was ` +
        "installed. Re-select the file and upload it again.",
    );
  }
  return recomputed;
}
