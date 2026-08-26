---
type: Convention
title: Read the index before you read a concept
description: Read the bundle's `index.md` before you open any concept.
source: docs/internals/workflows/memory-conventions.md
source_digest: sha256:d16e8bc804b5c409ed3184cf442dc27847c2c4aa916f498cabbd0672b068009b
---
Read the bundle's `index.md` before you open any concept. The bundle root
holds that file, and it lists every concept grouped by directory. It gives you
the title, the description, and the path of each concept in one file, so you
can pick the few concepts a task needs instead of reading the whole bundle.

The index is a derived artifact. The `memory` command regenerates it after
every write. Treat a stale or missing index as normal and fall back to
`memory list`.
