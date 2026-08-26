---
type: Convention
title: Choose the type field deliberately
description: Frontmatter `type` is the only required field, and it decides how a reader weighs the concept.
source: docs/internals/workflows/memory-conventions.md
source_digest: sha256:e59f14f3cc2ba65ac27aa8a84c94b0c6f3647a950fb1b0415d119484b4a9f3c8
---
Frontmatter `type` is the only required field, and it decides how a reader
weighs the concept. Use the kind that describes the insight: `Convention`,
`Correction`, `Command`, or `Debugging Insight`. Reuse an existing value
exactly, because recall filters on the literal string.

Add `title`, `description`, and `tags` as well. The description is the line a
reader sees in the index, so write it as one sentence that states the rule.
