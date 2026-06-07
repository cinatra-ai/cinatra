// -----------------------------------------------------------------------------
// Reserved-substrings mirror.
//
// The canonical reserved-patterns list lives in the private operations
// infrastructure that backs the registry vhost. This file is a comment-only
// mirror that the validator consumes; the operations side is the source of
// truth.
//
// Strategy: comment-only mirror. The list is short and rarely changes; a
// network dependency on the registry vhost is not worth introducing.
//
// When the canonical list changes, mirror the change here in a coordinated
// commit. The validator parametrizes on this constant so tests pull from the
// same source.
// -----------------------------------------------------------------------------

export const RESERVED_SUBSTRINGS: readonly string[] = ["cinatra"];
