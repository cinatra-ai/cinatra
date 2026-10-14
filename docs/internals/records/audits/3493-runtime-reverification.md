# Re-verification of #3493 on a head-built runtime

#3493 (an extension imported through the import screen on a production-built instance was recorded installed but never published to the agent runtime) was closed on evidence taken against an agent runtime that was older than the booted application head.

This record holds the re-verification on an instance whose agent runtime is built from the same head as the application:

- the pack is imported through the import screen;
- a reload reports more than zero mounted agents;
- one run of the imported agent reaches its first gate.

The reading's verdict and evidence are added to this file when the reading completes.
