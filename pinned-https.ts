/**
 * pinned-https.ts — one HTTPS GET that connects ONLY to an address the caller
 * already vetted (PR #8 review, P1: DNS check and connection must not resolve
 * separately).
 *
 * `fetch` resolves the hostname again on its own, so a DNS answer that changes
 * between the public-address check and the connection (rebinding) could reach
 * a private host. Here the connection's `lookup` is replaced by one that
 * returns the pinned, already-validated address and nothing else, while the
 * TLS layer still verifies the certificate against the URL's HOSTNAME (SNI
 * and the hostname check are unchanged), so pinning never weakens TLS.
 *
 * No redirects are followed (the caller re-validates every hop), no agent is
 * shared (no pooled socket to a different address), no cookies are sent.
 */

import { request } from 'node:https'
import { isIP } from 'node:net'

export interface PinnedAddress {
  address: string
  family: 4 | 6
}

export interface PinnedGetOptions {
  headers?: Record<string, string>
  timeoutMs?: number
  /** Aborts the request (connect, headers and body) — the overall deadline. */
  signal?: AbortSignal
  /** Extra trust anchors — tests only (a local self-signed server). */
  ca?: string | Buffer
}

type LookupCb = (
  err: NodeJS.ErrnoException | null,
  address: string | Array<{ address: string; family: number }>,
  family?: number,
) => void

/** A `lookup` that answers ONLY `host` and ONLY with the pinned address. */
export function pinnedLookup(host: string, pin: PinnedAddress) {
  return (hostname: string, options: unknown, callback?: LookupCb): void => {
    const cb = (typeof options === 'function' ? options : callback) as LookupCb
    if (hostname !== host) {
      cb(Object.assign(new Error(`pinned lookup refused ${hostname}`), { code: 'ENOTFOUND' }), '')
      return
    }
    const all =
      typeof options === 'object' && options !== null && (options as { all?: unknown }).all === true
    if (all) cb(null, [{ address: pin.address, family: pin.family }])
    else cb(null, pin.address, pin.family)
  }
}

const NULL_BODY_STATUS = new Set([101, 103, 204, 205, 304])

/** GET `url` over TLS, connecting only to `pin`. Resolves to a web `Response`
 *  (status + headers + streamed body); never follows a redirect. */
export function pinnedHttpsGet(
  url: URL,
  pin: PinnedAddress,
  opts: PinnedGetOptions = {},
): Promise<Response> {
  if (url.protocol !== 'https:') return Promise.reject(new Error('pinned GET is https only'))
  const host = url.hostname.replace(/^\[|\]$/g, '')
  return new Promise<Response>((resolveResp, reject) => {
    const req = request(
      {
        host,
        port: url.port === '' ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: opts.headers ?? {},
        agent: false,
        lookup: pinnedLookup(host, pin) as never,
        // SNI must be a name, never an IP literal; the certificate is still
        // checked against `host` either way.
        ...(isIP(host) === 0 ? { servername: host } : {}),
        ...(opts.ca !== undefined ? { ca: opts.ca } : {}),
      },
      (res) => {
        const headers = new Headers()
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue
          headers.set(k, Array.isArray(v) ? v.join(', ') : String(v))
        }
        const status = res.statusCode ?? 0
        if (NULL_BODY_STATUS.has(status) || (status >= 300 && status < 400)) {
          res.resume()
          resolveResp(new Response(null, { status, headers }))
          return
        }
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            res.on('data', (chunk: Buffer) => {
              controller.enqueue(new Uint8Array(chunk))
              if ((controller.desiredSize ?? 1) <= 0) res.pause()
            })
            res.on('end', () => controller.close())
            res.on('error', (err) => controller.error(err))
          },
          pull() {
            res.resume()
          },
          cancel() {
            res.destroy()
          },
        })
        resolveResp(new Response(body, { status, headers }))
      },
    )
    const signal = opts.signal
    if (signal !== undefined) {
      const onAbort = () => req.destroy(new Error('image download aborted'))
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
      req.on('close', () => signal.removeEventListener('abort', onAbort))
    }
    if (opts.timeoutMs !== undefined) {
      req.setTimeout(opts.timeoutMs, () => req.destroy(new Error('image download timed out')))
    }
    req.on('error', reject)
    req.end()
  })
}
