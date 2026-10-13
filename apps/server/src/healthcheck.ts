// Container health check: exits 0 only when the server reports ready.
const port = process.env.PORT ?? "8080"

try {
  const res = await fetch(`http://127.0.0.1:${port}/healthz/ready`, { signal: AbortSignal.timeout(4000) })
  process.exit(res.ok ? 0 : 1)
} catch {
  process.exit(1)
}

export {}
