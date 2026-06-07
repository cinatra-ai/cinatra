"use client";

import { ensureDefaultFieldRenderersRegistered } from "@cinatra-ai/agents/client-entry";

// Module-scope call: runs once when this chunk is loaded by the providers tree.
// Guarantees renderers are in the registry before any page renders.
ensureDefaultFieldRenderersRegistered();

// Renders nothing — pure side-effect registration module.
export function FieldRendererInit() {
  return null;
}
