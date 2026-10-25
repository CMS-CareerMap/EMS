// E2E ONLY: shifts this Node process's clock to FAKE_NOW (an ISO instant), so
// suites written against a particular day run as they did on it. Loaded with
// NODE_OPTIONS=--require …/fake-now.cjs; does nothing without FAKE_NOW.
//
// Playwright's own code keeps the real clock (25 Oct 2026). Its page clock
// sends the browser what it does stamped with Date.now(); from a Node shifted
// weeks back, the page's timers never fired — every page of the Sep 30 suites
// hung on "Loading…" once the real day was far enough past it. A suite's own
// code still sees FAKE_NOW, and the page is set to it with page.clock.
const target = process.env.FAKE_NOW ? Date.parse(process.env.FAKE_NOW) : NaN
if (!Number.isNaN(target)) {
  const RealDate = Date
  const offset = target - RealDate.now()
  const fromPlaywright = () => /[\\/]playwright-core[\\/]/.test(new Error().stack ?? '')
  class ShiftedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fromPlaywright() ? RealDate.now() : RealDate.now() + offset)
      else super(...args)
    }
    static now() {
      return fromPlaywright() ? RealDate.now() : RealDate.now() + offset
    }
  }
  globalThis.Date = ShiftedDate
}
