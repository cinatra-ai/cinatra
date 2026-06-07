// Vitest stub for `@/lib/toast`.
//
// The real module wraps `sonner`'s `toast` function with copy-icon
// behavior. At module-load it does `_toast.promise.bind(_toast)` etc.
// In the Node-only test environment, `sonner` resolves to a CJS shim
// where `toast` is undefined, causing "Cannot read properties of
// undefined (reading 'bind')" at module load. Tests don't render real
// toasts; a no-op stub is enough.
type ToastFn = (...args: unknown[]) => unknown;

const noop: ToastFn = () => undefined;

const t = noop as ToastFn & Record<string, ToastFn>;
t.error = noop;
t.success = noop;
t.warning = noop;
t.info = noop;
t.promise = noop;
t.loading = noop;
t.custom = noop;
t.dismiss = noop;
t.message = noop;

export const toast = t;
