// Registers the resolve hook in the sibling module so a child `node --import`
// run treats the gitignored `extensions/cinatra-ai/` connector source as
// ABSENT — exactly the fresh-checkout condition this fix targets — WITHOUT mutating
// the working tree. Used by tests/cold-import.test.mjs.
import { register } from "node:module";

register("./cold-import-block-extension.mjs", import.meta.url);
