import { describeError } from '../domain/result.ts'
import type { Fetch } from '../http.ts'

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

export class PushError extends Error {
  override readonly name = 'PushError'
  /** The receiver's HTTP status; undefined when it never answered. */
  readonly status: number | undefined
  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

/**
 * Only a 400's body is kept: it says which samples were rejected and why ("out of order sample").
 * Any other body may be a proxy's page echoing the request, Authorization header included, so it
 * is not logged - and a 400 body that mentions anything credential-like is withheld whole:
 * echoed headers come in too many shapes (JSON, Go maps, raw lines) to redact reliably, and the
 * receivers' own rejection messages never use these words.
 */
const MENTIONS_CREDENTIALS =
  /authorization|x-amz-|signature|credential|bearer|basic |token|password|secret/i

async function explain(response: Response): Promise<string> {
  if (response.status !== 400) return ''
  const body = (await response.text().catch(() => '')).replace(/[^\x20-\x7e]+/g, ' ').trim()
  if (MENTIONS_CREDENTIALS.test(body)) return ' (body withheld: it may echo credentials)'
  return ` ${body.slice(0, 300)}`.trimEnd()
}

export async function post(
  fetchImpl: Fetch,
  request: { url: string; headers: Record<string, string>; body: Uint8Array; timeoutMs: number },
  retryDelayMs = 500,
): Promise<void> {
  const deadline = Date.now() + request.timeoutMs
  for (let attempt = 1; ; attempt++) {
    let failure: PushError
    let retryable: boolean
    try {
      const response = await fetchImpl(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(Math.max(deadline - Date.now(), 1)),
      })
      if (response.ok) return
      failure = new PushError(
        `remote_write: ${response.status}${await explain(response)}`,
        response.status,
      )
      retryable = response.status >= 500
    } catch (err) {
      failure = new PushError(`remote_write: ${describeError(err)}`)
      retryable = true
    }
    if (!retryable || attempt >= 2 || deadline - Date.now() <= retryDelayMs) throw failure
    await new Promise(resolve => setTimeout(resolve, retryDelayMs))
  }
}
