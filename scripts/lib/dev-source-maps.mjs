// Source maps in the development server's process — one switch (cinatra#3758).
//
// WHY THIS EXISTS
//
// The development server grows far past its heap bound. Three development
// servers of this repository (Next.js 16.2.10 on Linux, read from each
// process's own accounting in /proc/<pid>/status) held 14.1 GB of anonymous
// memory at 44 minutes, 16.4 GB at 64 and 19.6 GB at 77, while the `dev` script
// bounds the V8 heap at 8192 MB. Most of that memory is outside the JavaScript
// heap: the bundler runs natively inside the same process, and the source maps
// Node.js keeps for every loaded module add to it. Whether the server needs
// those source maps by default is a question a measurement answers, and a
// measurement needs a switch.
//
// WHERE THE SWITCH GOES
//
// `next dev` starts its server process with `--enable-source-maps` whatever
// NODE_OPTIONS says, unless it is given `--disable-source-maps`
// (next/dist/cli/next-dev.js deletes the option in that case and sets it in
// every other). So the switch is an ARGUMENT to `next dev`, not an edit of
// NODE_OPTIONS: this launcher adds that one flag and changes nothing else.
// NODE_OPTIONS stays exactly what the `dev` script set.
//
// UNSET MEANS UNSET
//
// With CINATRA_DEV_SOURCE_MAPS unset or empty, `next dev` gets exactly the
// arguments it got before this file existed, and the server keeps its source
// maps. `0` leaves them out. Any other value refuses before the launcher does
// anything else: a misspelled value that silently kept the default would make a
// measurement report "source maps make no difference".
//
// The value is read the way the launcher reads its other settings: the shell
// first, then `.env.local` (the launch directory's, then the checkout root's).
//
// Everything here is pure; scripts/__tests__/dev-source-maps.test.mjs asserts
// it without starting a server.

/** The one variable that switches source maps in the development server's process. */
export const DEV_SOURCE_MAPS_ENV_VAR = "CINATRA_DEV_SOURCE_MAPS";

/** The one accepted value: it starts the server process without source maps. */
export const DEV_SOURCE_MAPS_OFF = "0";

/** The `next dev` flag that starts the server process without `--enable-source-maps`. */
export const DISABLE_SOURCE_MAPS_FLAG = "--disable-source-maps";

/**
 * The stated value, trimmed: the shell's when it states one, else the first
 * `.env.local` value that does. A blank value states nothing, as it does for
 * the launcher's other settings.
 *
 * @param {{ processEnv?: Record<string, string | undefined>, envFileValues?: Array<string | undefined> }} input
 * @returns {string | undefined}
 */
export function statedDevSourceMaps({ processEnv = {}, envFileValues = [] } = {}) {
  for (const raw of [processEnv[DEV_SOURCE_MAPS_ENV_VAR], ...envFileValues]) {
    if (raw === undefined || raw === null) continue;
    const value = String(raw).trim();
    if (value !== "") return value;
  }
  return undefined;
}

/**
 * Decide whether the server process keeps its source maps.
 *
 * Throws on any value other than unset, empty or `0`. The message names the
 * variable, the value and the accepted form, so the refusal says what to fix.
 *
 * @param {{ processEnv?: Record<string, string | undefined>, envFileValues?: Array<string | undefined> }} input
 * @returns {{ sourceMaps: boolean }}
 */
export function resolveDevSourceMaps(input = {}) {
  const stated = statedDevSourceMaps(input);
  if (stated === undefined) return { sourceMaps: true };
  if (stated === DEV_SOURCE_MAPS_OFF) return { sourceMaps: false };
  throw new Error(
    `${DEV_SOURCE_MAPS_ENV_VAR}="${stated}" is not an accepted value. ` +
      `Set it to ${DEV_SOURCE_MAPS_OFF} to start the development server without source maps, ` +
      "or leave it unset to keep them.",
  );
}

/**
 * The arguments the launcher hands `next`.
 *
 * With source maps kept this is `dev` followed by the launcher's own arguments,
 * exactly as before. With them off, `--disable-source-maps` is added once — not
 * a second time when the caller already passed it.
 *
 * @param {{ forwardedArgs?: string[], sourceMaps?: boolean }} input
 * @returns {string[]}
 */
export function resolveNextDevArgs({ forwardedArgs = [], sourceMaps = true } = {}) {
  const args = ["dev", ...forwardedArgs];
  if (!sourceMaps && !forwardedArgs.includes(DISABLE_SOURCE_MAPS_FLAG)) {
    args.push(DISABLE_SOURCE_MAPS_FLAG);
  }
  return args;
}
