/**
 * Main-thread `Promise.withResolvers` polyfill for the react-pdf fallback.
 *
 * pdfjs-dist 5.x calls `Promise.withResolvers` (Baseline 2024; iOS/desktop
 * Safari gained it in 17.4). This module MUST be imported before
 * `react-pdf` — ESM evaluates imports in source order, so the side effect
 * runs before pdfjs-dist's main-thread module evaluates.
 *
 * Scope note: this protects the MAIN THREAD only. The pdf.js WORKER runs
 * in its own realm and also uses the API, so the effective floor for the
 * inline fallback is Safari 17.4+ (March 2024). On older engines the
 * worker fails to start, react-pdf surfaces a load error, and the viewer's
 * error state offers the download link instead — graceful degradation,
 * never a blank page.
 */

if (typeof Promise.withResolvers !== "function") {
  Promise.withResolvers = function withResolvers<T>(): PromiseWithResolvers<T> {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };
}

export {};
