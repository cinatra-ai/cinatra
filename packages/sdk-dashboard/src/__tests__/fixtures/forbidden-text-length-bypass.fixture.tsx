// Intentionally violates the arbitrary text-[…] ban (cinatra#803) through
// the `length:` prefix: only `text-[length:inherit]` is carved out, so an
// explicit `text-[length:<value>]` must still be flagged.
export const lengthPrefixBypass = "text-[length:12px]";
