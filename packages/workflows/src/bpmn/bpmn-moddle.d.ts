// Minimal ambient declaration for `bpmn-moddle` (v10 ships no types). We use only
// the named `BpmnModdle` constructor + `fromXML` / `toXML`. The parsed graph is
// navigated as loose `{ $type, ... }` moddle objects in profile.ts / compile.ts.
declare module "bpmn-moddle" {
  export interface BpmnModdleParseResult {
    rootElement: unknown;
    references?: unknown[];
    warnings?: Array<{ message?: string } | string>;
    elementsById?: Record<string, unknown>;
  }
  export interface BpmnModdleSerializeResult {
    xml: string;
  }
  export class BpmnModdle {
    constructor(packages?: Record<string, unknown>, options?: Record<string, unknown>);
    fromXML(xml: string, typeName?: string): Promise<BpmnModdleParseResult>;
    toXML(element: unknown, options?: Record<string, unknown>): Promise<BpmnModdleSerializeResult>;
  }
}
