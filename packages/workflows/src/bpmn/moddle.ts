// `bpmn-moddle` instance factory + async XML→definitions parse. This is the ONLY
// async/I/O-touching module in the BPMN surface besides `sidecar.ts`; the compiler
// + validator stay pure over the returned `definitions` object. No `server-only`
// here on purpose — the CI gate (`scripts/audit/workflow-bpmn-gate.mjs`, run under
// `node --import tsx`) imports this surface and must not trip the Next.js guard.

import { BpmnModdle } from "bpmn-moddle";
import { cinatraModdleDescriptor } from "./moddle-descriptor";
import { BPMN_ERROR_CODES } from "./errors";

/** A BpmnModdle pre-loaded with the `cinatra:` Profile 1.0 descriptor. */
export function createCinatraBpmnModdle(): BpmnModdle {
  return new BpmnModdle({ cinatra: cinatraModdleDescriptor as unknown as Record<string, unknown> });
}

export type BpmnXmlParseResult =
  | { ok: true; definitions: unknown }
  | { ok: false; code: typeof BPMN_ERROR_CODES.parseError; detail: string };

/**
 * Parse BPMN XML into a moddle `definitions` object using the Cinatra descriptor.
 * Fails CLOSED: any thrown error OR any moddle warning (unknown element/attr) →
 * structured `bpmn_parse_error` (Cinatra-authored BPMN must parse cleanly).
 */
export async function parseBpmnXml(xml: string): Promise<BpmnXmlParseResult> {
  const moddle = createCinatraBpmnModdle();
  try {
    const { rootElement, warnings } = await moddle.fromXML(xml);
    const warns = warnings ?? [];
    if (warns.length > 0) {
      const detail = warns.map((w) => (typeof w === "string" ? w : (w.message ?? "unknown warning"))).join("; ");
      return { ok: false, code: BPMN_ERROR_CODES.parseError, detail: `moddle parse warnings: ${detail}` };
    }
    return { ok: true, definitions: rootElement };
  } catch (e) {
    return { ok: false, code: BPMN_ERROR_CODES.parseError, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** Serialize a moddle definitions object back to XML (used by round-trip tests). */
export async function serializeBpmnDefinitions(definitions: unknown): Promise<string> {
  const moddle = createCinatraBpmnModdle();
  const { xml } = await moddle.toXML(definitions);
  return xml;
}
