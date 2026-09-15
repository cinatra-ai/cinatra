---
type: Command
title: Author a concept with the memory command
description: Write concepts through the `memory add` command rather than by hand, because it enforces the identity, containment, and size rules for you.
source: docs/internals/workflows/memory-conventions.md
source_digest: sha256:6c75d33412570fbcda334b2efa6a45887076aa000aaf4c60216cc96df4531b74
---
Write concepts through the `memory add` command rather than by hand, because it
enforces the identity, containment, and size rules for you:

```sh
memory add --type Convention \
  --title "Run the package suite with the workspace filter" \
  --description "Use the pnpm workspace filter to run one package suite." \
  --tags testing,pnpm \
  --body "Run \`pnpm --filter <package> test\`. A bare \`vitest\` run picks up the root config."
```

The command derives the path from the type and the title, writes the file
atomically, and regenerates the index. Pass `--path <rel.md>` when you need a
specific location, and `--body-file <file>` or standard input for a long body.
