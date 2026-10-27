// A FAILURE LOG WITHOUT EXCEPTION TEXT THAT NEVER THROWS (cinatra#4223).
//
// A thrown value's message, or its string form, can carry a connection string,
// a credential, a table name or a provider's own answer. A failure's server log
// therefore records a fixed sentence, the caller's own identifiers and the
// error's class and code, never its text.
//
// Reading the class and the code runs no getter and does not convert the
// thrown value: it reads property descriptors only. A class name or a code
// that does not have the plain form of an identifier or a code is not logged.
// A log line that cannot be written is dropped, so logging never changes the
// answer a caller gets.

const CLASS_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const ERROR_CODE = /^[A-Z0-9_]{2,40}$/;

/** The class, and a plain code if the error has one, of a thrown value. Never its text. */
export function failureClass(err: unknown): { errorClass: string; errorCode?: string } {
  try {
    if (err === null) return { errorClass: "null" };
    const kind = typeof err;
    if (kind !== "object" && kind !== "function") return { errorClass: kind };
    const proto: unknown = Object.getPrototypeOf(err);
    const ctor =
      proto !== null && (typeof proto === "object" || typeof proto === "function")
        ? Reflect.getOwnPropertyDescriptor(proto, "constructor")?.value
        : undefined;
    const name =
      typeof ctor === "function" ? Reflect.getOwnPropertyDescriptor(ctor, "name")?.value : undefined;
    const errorClass = typeof name === "string" && CLASS_NAME.test(name) ? name : "object";
    const code = Reflect.getOwnPropertyDescriptor(err as object, "code")?.value;
    return typeof code === "string" && ERROR_CODE.test(code)
      ? { errorClass, errorCode: code }
      : { errorClass };
  } catch {
    return { errorClass: "unreadable" };
  }
}

/**
 * Log a failure as `sentence`, the caller's `fields` and the error's class and
 * code. Never the error's text, and never a throw.
 */
export function logFailure(sentence: string, fields: Record<string, string>, err: unknown): void {
  try {
    console.error(sentence, { ...fields, ...failureClass(err) });
  } catch {
    /* a log line that cannot be written is dropped; the answer never depends on it */
  }
}

/** Log a fixed `sentence` with the caller's `fields` only. Never a throw. */
export function logFixedLine(sentence: string, fields: Record<string, string>): void {
  try {
    console.error(sentence, { ...fields });
  } catch {
    /* dropped, as above */
  }
}
