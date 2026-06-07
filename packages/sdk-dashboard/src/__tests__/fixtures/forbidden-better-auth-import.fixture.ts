// FIXTURE — ESLint should flag this. Imports better-auth from inside
// sdk-dashboard, which is forbidden by ADR 0044 (auth is host-provided
// via context, not direct dep).
//
// eslint-disable-next-line no-unused-vars
import { betterAuth } from "better-auth";

export const used = betterAuth;
