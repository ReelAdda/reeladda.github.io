// Moves the clock forward for a test run, to catch tests that only pass on today's date.
//   TEST_CLOCK_SHIFT_DAYS=30 node -r ./scripts/testclock.js scripts/test.js
// Used by .github/workflows/future-tests.yml once a week. On 8 Oct 2026 a test whose film
// window lapsed with the real calendar stopped the day's update; run 30 days ahead, the same
// test fails a month early in a run that publishes nothing.
"use strict";
const vm = require("vm");

const shift = Number(process.env.TEST_CLOCK_SHIFT_DAYS || 0) * 864e5;
const RealDate = Date;
class ShiftedDate extends RealDate {
  constructor(...args) { if (args.length) super(...args); else super(RealDate.now() + shift); }
  static now() { return RealDate.now() + shift; }
}
global.Date = ShiftedDate;

// Tests that run the browser's code in a vm sandbox would otherwise get the real clock there.
const createContext = vm.createContext;
vm.createContext = (sandbox = {}, ...rest) => {
  if (sandbox && typeof sandbox === "object" && !("Date" in sandbox)) sandbox.Date = ShiftedDate;
  return createContext(sandbox, ...rest);
};
