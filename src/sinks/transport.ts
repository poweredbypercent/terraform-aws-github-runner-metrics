/**
 * One HTTP POST with the remote-write retry rules:
 *
 *  - 2xx: done.
 *  - 4xx (429 included): not retried. A 400 is usually an out-of-order or duplicate sample, and
 *    resending the same timestamps can only fail again; the next scheduled sample is the retry.
 *  - 5xx or a network error: retried once after a short pause, within the timeout.
 *
 * Failures throw, so the invocation counts as failed in the Lambda's own metrics.
 */

export type Fetch = typeof fetch

export class PushError extends Error {
  override readonly name = 'PushError'
}

export async function post(
  fetchImpl: Fetch,
  request: { url: string; headers: Record<string, string>; body: Uint8Array; timeoutMs: number },
  retryDelayMs = 500,
): Promise<void> {
  const deadline = Date.now() + request.timeoutMs
  for (let attempt = 1; ; attempt++) {
    const remaining = deadline - Date.now()
    let failure: string
    try {
      const response = await fetchImpl(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(Math.max(remaining, 1)),
      })
      if (response.ok) return
      // The body explains rejections ("out of order sample"); cap it, it can echo the request.
      const detail = (await response.text().catch(() => '')).slice(0, 300)
      failure = `remote_write: ${response.status}${detail ? ` ${detail}` : ''}`
      if (response.status < 500) throw new PushError(failure)
    } catch (err) {
      if (err instanceof PushError) throw err
      failure = `remote_write: ${err instanceof Error ? err.message : String(err)}`
    }
    if (attempt >= 2 || deadline - Date.now() <= retryDelayMs) throw new PushError(failure)
    await new Promise(resolve => setTimeout(resolve, retryDelayMs))
  }
}
