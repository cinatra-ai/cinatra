// WHOSE CODE AN AUDIT EVENT OF THE TOOL ROAD RECORDS (cinatra#4154, spec v2.2
// section 2.7).
//
// Since an embedded child step may run the child's code under the parent's
// run, "the extension" an audit event names is no longer enough to say which
// package's code acted for which run. Every event the `extension_tool` road
// writes - its own dispatch event and the events of the ports it hands a
// module - therefore carries the same four fields, threaded as one object.
// Nothing here names a package; the values come from the bound run and the
// origin resolver.

/** The four fields every audit event of the tool road carries. */
export type ExtensionToolAttribution = {
  /** The run's own package; null when the run resolves to none. */
  runPackage: string | null;
  /** The package whose code ran; null when no origin was resolved. */
  codePackage: string | null;
  /** The exact child installation the code loaded from; null on the run package's own road. */
  codeInstallId: string | null;
  /** The step the route verified from the runtime's signed pair. */
  verifiedStepId: string | null;
};

/** The audit write the tool road's writers take. */
export type ExtensionToolAuditWriter = (event: Record<string, unknown>) => Promise<void>;

/** Exactly the four fields, whatever else the object carries. */
export function attributionFields(a: ExtensionToolAttribution): ExtensionToolAttribution {
  return {
    runPackage: a.runPackage,
    codePackage: a.codePackage,
    codeInstallId: a.codeInstallId,
    verifiedStepId: a.verifiedStepId,
  };
}

/**
 * The writer, with the four fields added to each event's metadata, after its
 * own fields, so no other field can stand in for one of them. Without an
 * attribution (every caller outside the tool road) the same writer.
 */
export function withAttribution(
  audit: ExtensionToolAuditWriter,
  attribution: ExtensionToolAttribution | undefined,
): ExtensionToolAuditWriter {
  if (attribution === undefined) return audit;
  const fields = attributionFields(attribution);
  return (event) => {
    const metadata = event.metadata;
    const own =
      typeof metadata === "object" && metadata !== null && !Array.isArray(metadata) ? metadata : {};
    return audit({ ...event, metadata: { ...own, ...fields } });
  };
}
