// -----------------------------------------------------------------------------
// The INSTANCE DISPLAY NAME policy — ONE schema, both callers.
//
// The Name screen validates the display name with a Zod schema and the
// namespace with the shared `validateInstanceNamespace` module. The namespace
// half was already shared; this module makes the display-name half shared too,
// so a non-browser caller cannot drift from the screen by re-deriving
// "trim, at least one character, at most 120". A "use server" module may only
// export async functions, so the schema cannot be exported from the action file
// itself — the same reason `./registry-url` and the deferred persistence path
// were extracted from it.
// -----------------------------------------------------------------------------

import { z } from "zod";

export const INSTANCE_DISPLAY_NAME_MAX_LENGTH = 120;

export const instanceDisplayNameSchema = z.object({
  instanceDisplayName: z
    .string()
    .trim()
    .min(1, "Instance display name is required.")
    .max(
      INSTANCE_DISPLAY_NAME_MAX_LENGTH,
      `Instance display name must be ${INSTANCE_DISPLAY_NAME_MAX_LENGTH} characters or fewer.`,
    ),
});

export type InstanceDisplayNameParseResult =
  | { ok: true; instanceDisplayName: string }
  | { ok: false; message: string };

/** The same policy the screen applies, as a plain result for non-browser callers. */
export function parseInstanceDisplayName(value: unknown): InstanceDisplayNameParseResult {
  const parsed = instanceDisplayNameSchema.safeParse({
    instanceDisplayName: typeof value === "string" ? value : String(value ?? ""),
  });
  if (!parsed.success) {
    return {
      ok: false,
      message:
        parsed.error.issues[0]?.message ??
        `Instance display name must be ${INSTANCE_DISPLAY_NAME_MAX_LENGTH} characters or fewer.`,
    };
  }
  return { ok: true, instanceDisplayName: parsed.data.instanceDisplayName };
}
