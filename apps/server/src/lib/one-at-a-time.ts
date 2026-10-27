const tails = new Map<string, Promise<unknown>>()

/**
 * Runs the calls with the same key one at a time, in the order they came, so a later one never interleaves with an
 * earlier one (an earlier health check's alerts after a later check's, for example). One server process, as
 * supported; across processes the database row locks still keep each write consistent.
 */
export function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (tails.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn)
  const tail = run.catch(() => undefined)
  tails.set(key, tail)
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key)
  })
  return run
}
