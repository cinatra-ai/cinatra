import { isAppDevelopmentMode } from "./runtime-mode";

/**
 * May this instance take a plain-http LOOPBACK address where it otherwise
 * requires https? Only while the app runs in development mode. The runtime-mode
 * declaration decides when one is set (`CINATRA_RUNTIME_MODE`, then
 * `APP_RUNTIME_MODE`: a development word reads development, every other word
 * production), and the build decides when none is (`runtime-mode.ts`). So an
 * application built for production that its operator runs in development mode
 * takes a loopback http address, and an instance in production mode never does.
 *
 * Read by the connect registration (`validateRedirectUri` and
 * `validateWidgetOrigin` in `connect-provisioning.ts`), which still limits the
 * http exception to its own loopback host names; this answers only whether the
 * instance's mode allows the exception at all.
 *
 * A leaf on purpose: it imports nothing but the runtime-mode reading, so a
 * module can read the rule without taking on the connect stores' import graph.
 */
export function allowsLoopbackHttp(): boolean {
  return isAppDevelopmentMode();
}
