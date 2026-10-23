/*
 * The result of a connection test (Telegram, Email) belongs to the values it was run with and to the request
 * that ran it (FS-19, SV-5). Each start is a new generation and remembers the values it sent: an answer to an
 * older start is dropped, and a result shows as Accepted or Failed only while the values on screen are still
 * the ones it tested. A change during the test or after it leaves "not tested with these values". A stored
 * secret is not among the values sent, so the caller's values text also names the stored secrets of then
 * (`testIdentity` in pages/settings.tsx): once a new one is saved, the old result no longer counts.
 */

export type TestOutcome = { ok: true; detail?: string } | { ok: false; message: string }

export type TestRun = { generation: number; values: string }

export type TestView =
  | { kind: "none" }
  | { kind: "testing" }
  | { kind: "accepted"; detail?: string; at: number }
  | { kind: "failed"; message: string; at: number }
  /** The values on screen are not the ones the last test ran with, changed during it or after it. */
  | { kind: "changed"; at: number }

export function createTestRuns() {
  let generation = 0
  let running: TestRun | null = null
  let result: { values: string; at: number; outcome: TestOutcome } | null = null
  return {
    /** A new test of these values (any text that compares equal for equal values, such as JSON). */
    start(values: string): TestRun {
      generation += 1
      running = { generation, values }
      return running
    },
    /** The answer to a test. False when a newer test started since, and the answer is dropped. */
    settle(run: TestRun, outcome: TestOutcome, at: number): boolean {
      if (run.generation !== generation) return false
      running = null
      result = { values: run.values, at, outcome }
      return true
    },
    /** Forgets a test still on its way, so its answer is dropped (the form was reloaded or left). */
    drop() {
      generation += 1
      running = null
    },
    /** What to show beside the test button for the values on screen now. */
    view(values: string): TestView {
      if (running) return { kind: "testing" }
      if (!result) return { kind: "none" }
      if (result.values !== values) return { kind: "changed", at: result.at }
      return result.outcome.ok
        ? { kind: "accepted", detail: result.outcome.detail, at: result.at }
        : { kind: "failed", message: result.outcome.message, at: result.at }
    },
  }
}
