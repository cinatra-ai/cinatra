---
type: Convention
title: Recall before you act
description: Search the bundle before you answer a question, choose a convention, or run a project command.
source: docs/internals/workflows/memory-conventions.md
source_digest: sha256:d05ec12b8b3c6fc62d96a654e3969c39dea8ce8b8c43aa402c05393fab9a4563
---
Search the bundle before you answer a question, choose a convention, or run a
project command. Use `memory recall <query>` for a lexical search over titles,
descriptions, tags, and bodies. Use `memory list --type <kind>` when you want
every concept of one kind.

A recall costs one fast local command. A wrong answer that memory already
holds costs the reader much more. Recall first, then act.
