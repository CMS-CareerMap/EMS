// E2E ONLY: shifts this Node process's clock to FAKE_NOW (an ISO instant), so
// suites written against a particular day run as they did on it. Loaded with
// NODE_OPTIONS=--require …/fake-now.cjs; does nothing without FAKE_NOW.
const target = process.env.FAKE_NOW ? Date.parse(process.env.FAKE_NOW) : NaN
if (!Number.isNaN(target)) {
  const RealDate = Date
  const offset = target - RealDate.now()
  class ShiftedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offset)
      else super(...args)
    }
    static now() {
      return RealDate.now() + offset
    }
  }
  globalThis.Date = ShiftedDate
}
