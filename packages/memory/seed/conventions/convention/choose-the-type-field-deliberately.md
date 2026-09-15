---
type: Convention
title: Choose the type field deliberately
description: Set frontmatter `type` to the kind that describes the insight, from `Convention`, `Correction`, `Command`, and `Debugging Insight`.
source: docs/internals/workflows/memory-conventions.md
source_digest: sha256:35665451ed7085da41b2e81f6ee75d013383f864212dce1093463182d38fe262
---
Set frontmatter `type` to the kind that describes the insight, from
`Convention`, `Correction`, `Command`, and `Debugging Insight`. It is the only
required field, and it decides how a reader weighs the concept. Reuse an
existing value exactly, because recall filters on the literal string.

Add `title`, `description`, and `tags` as well. The description is the line a
reader sees in the index, so write it as one sentence that states the rule.
