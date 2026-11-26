// A loader plugin of the development media fixture (file-media-kinds.mjs): the
// type picker's server action (src/app/artifacts/upload-typing-actions.ts) gets
// the fixture's session module for `@/lib/auth-session` and a cache module for
// `next/cache`, because the fixture runs outside a request. Only that action's
// own import declarations are rewritten (a resolver hook would not do: the SSR
// loader keeps a package import such as `next/cache` external); every module
// the action calls keeps the real ones. An action that no longer imports both
// fails the load, so a drift is never a silent no-op.
import path from "node:path";

const SWAPS = {
  "@/lib/auth-session": "/scripts/fixtures/lib/picker-session.ts",
  "next/cache": "/scripts/fixtures/lib/picker-cache.ts",
};

export function pickerActionSessionPlugin(root) {
  const action = path.join(root, "src/app/artifacts/upload-typing-actions.ts");
  return {
    name: "fixture-picker-action-session",
    enforce: "pre",
    transform(code, id) {
      if (id.split("?")[0] !== action) return undefined;
      const seen = new Set();
      const out = code.replace(/(\bfrom\s*)(["'])(@\/lib\/auth-session|next\/cache)\2/g, (_m, from, q, spec) => {
        seen.add(spec);
        return `${from}${q}${SWAPS[spec]}${q}`;
      });
      const missing = Object.keys(SWAPS).filter((spec) => !seen.has(spec));
      if (missing.length) {
        throw new Error(`The type picker's action no longer imports ${missing.join(" and ")}: the fixture's session swap needs updating`);
      }
      return { code: out, map: null };
    },
  };
}
