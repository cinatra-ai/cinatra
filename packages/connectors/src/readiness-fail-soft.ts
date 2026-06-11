// FAIL-SOFT readiness resolution for the /connectors index (cinatra#110).
//
// The index iterates EVERY visible connector and resolves each card's
// readiness through the connector's registry probe. A single probe that
// throws — the extension is not bundled in this image, its host runtime deps
// were never registered at boot, or its status read fails — must degrade that
// ONE card to "not connected", never 500 the whole aggregate page. The
// per-connector setup routes keep their own (louder) failure handling; this
// helper is only the index's render-time containment.

export type ReadinessSnapshot = {
  connected: boolean;
  connectedLabel?: string;
};

export async function resolveReadinessFailSoft(
  slug: string,
  probe: () => Promise<ReadinessSnapshot> | ReadinessSnapshot,
  log: (message: string, error: unknown) => void = (message, error) =>
    console.error(message, error),
): Promise<ReadinessSnapshot> {
  try {
    return await probe();
  } catch (error) {
    log(
      `[connectors] readiness probe failed for "${slug}" — rendering the card as not connected`,
      error,
    );
    return { connected: false };
  }
}
