const tails = new Map<string, Promise<unknown>>()

export function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (tails.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn)
  const tail = run.catch(() => undefined)
  tails.set(key, tail)
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key)
  })
  return run
}
