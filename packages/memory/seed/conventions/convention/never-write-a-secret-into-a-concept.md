---
type: Convention
title: Never write a secret into a concept
description: An API key, a token, a password, a private URL with an embedded credential, or a customer identifier must never reach a concept file, a title, a description, or a tag.
source: docs/internals/workflows/memory-conventions.md
source_digest: sha256:262274789e7726c12870239b909315fd3e044a109416c4b160472b4c7c234f2e
---
An API key, a token, a password, a private URL with an embedded credential, or
a customer identifier must never reach a concept file, a title, a description,
or a tag. A bundle is committed, diffed, reviewed, and synced, so a secret in a
concept travels everywhere the bundle travels.

Record the name of the variable that holds the credential and the place it
comes from. Write "read the token from `GITHUB_TOKEN`" and never the token
value. Remove the concept immediately when a secret does reach one, and rotate
the credential, because the file is already in history.
