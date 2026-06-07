// -----------------------------------------------------------------------------
// Instance namespace validation types.
//
// Discriminated union for structured validation errors. The verbatim error
// message is composed at the render layer, not stored here.
// -----------------------------------------------------------------------------

export type NamespaceValidationError =
  | { code: "required" }
  | { code: "format"; canonical: string }
  | {
      code: "reserved";
      canonical: string;
      reservedSubstring: string;
      contact: { channel: string; href?: string };
    };

export type NamespaceValidationResult =
  | { ok: true; canonical: string }
  | { ok: false; canonical: string; error: NamespaceValidationError };
