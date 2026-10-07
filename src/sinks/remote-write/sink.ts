import type { Sample } from '../../model/catalogue.ts'
import type { Auth } from '../auth.ts'
import { type Fetch, post } from '../transport.ts'
import { encodeWriteRequest } from './protobuf.ts'
import { snappyLiterals } from './snappy.ts'

export interface Sink {
  push(samples: readonly Sample[]): Promise<void>
}

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
      const body = snappyLiterals(encodeWriteRequest(samples))
      const headers = await options.auth({
        url: options.url,
        body,
        headers: {
          ...options.headers,
          'content-encoding': 'snappy',
          'content-type': 'application/x-protobuf',
          'user-agent': options.userAgent,
          'x-prometheus-remote-write-version': '0.1.0',
        },
      })
      await post(options.fetch, { url: options.url, headers, body, timeoutMs: options.timeoutMs })
    },
  }
}
