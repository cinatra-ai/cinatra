// FIXTURE — ESLint should flag this. Imports a Cinatra package from inside
// sdk-dashboard, which is forbidden by ADR 0044.
//
// eslint-disable-next-line no-unused-vars
import { something } from "@cinatra-ai/sdk-ui";

export const used = something;
