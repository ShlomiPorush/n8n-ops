const running = new Set<Promise<unknown>>()
let stopped = false

export function own<T>(work: Promise<T>): Promise<T> {
  running.add(work)
  const done = () => running.delete(work)
  work.then(done, done)
  return work
}

export const stopping = () => stopped

export async function settleOwnedWork() {
  stopped = true
  while (running.size) await Promise.allSettled([...running])
}
