// -----------------------------------------------------------------------------
// Public surface for instance namespace validation.
//
// Single import path for both client and server consumers. Consumers should
// import from this barrel instead of `./validator` or `./types` directly so the
// public export surface can be asserted in one place.
// -----------------------------------------------------------------------------

export {
  validateInstanceNamespace,
  canonicalizeInstanceNamespace,
  NAMESPACE_FORMAT_REGEX_SOURCE,
} from "./validator";
export { RESERVED_SUBSTRINGS } from "./reserved-patterns";
export { composeNamespaceErrorMessage } from "./compose-error-message";
export type {
  NamespaceValidationError,
  NamespaceValidationResult,
} from "./types";
