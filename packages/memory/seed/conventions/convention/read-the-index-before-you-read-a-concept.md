---
type: Convention
title: Read the index before you read a concept
description: The bundle root holds an `index.md` file that lists every concept, grouped by directory.
source: docs/internals/workflows/memory-conventions.md
source_digest: sha256:e3d93b49118ea40a5b3b58b6186c6a8385c6d206fa8205667e4a48b36b0bcb92
---
The bundle root holds an `index.md` file that lists every concept, grouped by
directory. Read it first. It gives you the title, the description, and the path
of each concept in one file, so you can pick the few concepts a task needs
instead of reading the whole bundle.

The index is a derived artifact. The `memory` command regenerates it after
every write. Treat a stale or missing index as normal and fall back to
`memory list`.
