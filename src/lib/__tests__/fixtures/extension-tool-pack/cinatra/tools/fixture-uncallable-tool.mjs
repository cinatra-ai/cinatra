// A FIXTURE pack's declared module that exports no callable under the name the
// contract pins (cinatra#3249). The host refuses it rather than guessing at
// another export.

export const notTheExport = 1;
