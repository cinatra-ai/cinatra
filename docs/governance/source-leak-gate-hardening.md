# Source-leak gate: internal-tracker reference hardening

The source-leak gate now flags references to the internal engineering tracker in
public source — issue shorthands, fully-qualified references, and tracker issue
URLs — with an explicit allowlist for any deliberately-public reference.

Existing references in public source were rephrased to public-safe wording
(describing the change, or citing a public spec/protocol by name) rather than
deleted, so no context was lost.

Rationale: public repositories must not reference the private engineering
tracker (the public→private reference ban). The gate uses a line-ratchet, so it
only blocks net-new references; the allowlist covers intentional exceptions.
