import type { Fetch } from '../../http.ts'
import type { Sink } from '../../ports.ts'
import type { Auth } from '../auth.ts'
import { PushError, post } from '../transport.ts'
import { encodeWriteRequest } from './protobuf.ts'
import { snappyLiterals } from './snappy.ts'

/** Remote write 1.0: a snappy-framed protobuf WriteRequest, authenticated, then posted. */
export function remoteWriteSink(options: {
  url: string
  auth: Auth
  headers: Readonly<Record<string, string>>
  timeoutMs: number
  userAgent: string
  fetch: Fetch
}): Sink {
  return {
    async push(samples) {
      if (samples.length === 0) return
      const started = Date.now()
      const body = snappyLiterals(encodeWriteRequest(samples))
      // Reading a secret or credentials comes out of the same budget as the post itself.
      const headers = await options.auth.sign(
        {
          url: options.url,
          body,
          headers: {
            ...options.headers,
            'content-encoding': 'snappy',
            'content-type': 'application/x-protobuf',
            'user-agent': options.userAgent,
            'x-prometheus-remote-write-version': '0.1.0',
          },
        },
        AbortSignal.timeout(options.timeoutMs),
      )
      const timeoutMs = Math.max(options.timeoutMs - (Date.now() - started), 1)
      try {
        await post(options.fetch, { url: options.url, headers, body, timeoutMs })
      } catch (err) {
        if (err instanceof PushError && (err.status === 401 || err.status === 403)) {
          options.auth.refused()
        }
        throw err
      }
    },
  }
}
