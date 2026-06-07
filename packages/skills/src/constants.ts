/**
 * Test fixture & dev-bypass fallback for the legacy single-user mode.
 *
 * Production paths must NOT reference this constant. Skill-assignment code
 * paths thread `actor.principalId` from `ActorContext`. The only sanctioned
 * uses of LOCAL_USER_ID are:
 *
 *   1. Test fixtures (`packages/skills/src/__tests__/*`,
 *      `packages/skills/src/*.test.ts`).
 *   2. The `BETTER_AUTH_DEV_BYPASS=true` fallback inside MCP handlers
 *      and server actions, where there is no session actor available.
 *
 * If you find yourself wanting to import this in a new production file:
 * stop. Thread `ActorContext` instead.
 */
export const LOCAL_USER_ID = "local-user";
