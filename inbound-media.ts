/**
 * inbound-media.ts — images that arrive WITHOUT a Slack `files` entry
 * (H-20261119-057 step 2, part B).
 *
 * A GIF from Slack's GIF picker or /giphy, and many app/unfurl messages, carry
 * the picture as a Block Kit `image` block (`image_url` + `alt_text`, or a
 * `slack_file`) or as a legacy `attachments` entry (`image_url` / `thumb_url`,
 * `title`, `fallback`). Such a message has empty `text` and no `files`, so it
 * used to reach the agent as an empty message with no attachment_count.
 *
 * This module:
 *  - finds those images (`extractInboundImages`) and describes every
 *    attachment of a message, files included, with a `kind`
 *    (`describeInboundMedia`): one `[GIF: …]` / `[image: …]` text line per
 *    image, a count, and per-entry descriptors;
 *  - downloads one image URL safely (`fetchInboundImage`): the bot token goes
 *    ONLY to https://files.slack.com, and only when the download started
 *    there; every other host is fetched with no token and no cookies, https
 *    only, every hop's host resolved and refused if it is private/loopback,
 *    redirects followed by hand (bounded, each re-checked), body capped,
 *    content-type must be a raster image/*.
 *
 * Pure module: fetch and DNS are injected so it is unit-tested with fakes.
 */

import { isIP } from 'node:net'

export type InboundMediaKind = 'file' | 'image_block' | 'legacy_attachment'

/** One image found in `blocks` or legacy `attachments`. */
export interface InboundImage {
  kind: 'image_block' | 'legacy_attachment'
  /** alt_text / title / fallback, cleaned for display. */
  label: string
  isGif: boolean
  /** A public or Slack-hosted URL (image_url, thumb_url, slack_file.url). */
  url?: string
  /** A Slack file id (slack_file.id) — resolved through files.info. */
  slackFileId?: string
}

export interface InboundMediaEntry {
  kind: InboundMediaKind
  /** Display text for the entry (file name + type, or the image label). */
  description: string
}

export interface InboundMediaSummary {
  /** One `[GIF: …]` / `[image: …]` line per non-file image. */
  lines: string[]
  /** Files + images. */
  count: number
  entries: InboundMediaEntry[]
}

const LABEL_MAX = 200

/** Clean an attacker-controlled label for a one-line `[GIF: …]` text and a
 *  meta attribute: no control chars, no tag/attribute delimiters, no square
 *  brackets (they would close the `[GIF: …]` marker), one line, capped. */
export function cleanMediaLabel(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const cleaned = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strip C0/C1 controls from untrusted Slack text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[<>"'`[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.length > LABEL_MAX ? `${cleaned.slice(0, LABEL_MAX - 1)}…` : cleaned
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

const GIF_HOST_RE = /(^|\.)(giphy\.com|tenor\.com|tenor\.co)$/i

/** A GIF when the URL path ends in .gif, the host is a GIF service, or the
 *  attachment names GIPHY/Tenor as its service. */
export function looksLikeGif(url: string | undefined, serviceName?: unknown): boolean {
  if (typeof serviceName === 'string' && /giphy|tenor/i.test(serviceName)) return true
  if (url === undefined) return false
  try {
    const u = new URL(url)
    return /\.gif$/i.test(u.pathname) || GIF_HOST_RE.test(u.hostname)
  } catch {
    return /\.gif(\?|$)/i.test(url)
  }
}

function imageFromBlock(b: Record<string, unknown>): InboundImage | undefined {
  const title = (b.title as Record<string, unknown> | undefined)?.text
  const label = cleanMediaLabel(str(b.alt_text) ?? str(title) ?? '') || 'image'
  const url = str(b.image_url)
  if (url !== undefined) return { kind: 'image_block', label, isGif: looksLikeGif(url), url }
  const sf = b.slack_file as Record<string, unknown> | undefined
  if (sf && typeof sf === 'object') {
    const id = str(sf.id)
    const sfUrl = str(sf.url)
    if (id === undefined && sfUrl === undefined) return undefined
    return {
      kind: 'image_block',
      label,
      isGif: looksLikeGif(sfUrl) || /\.gif$/i.test(label),
      ...(sfUrl !== undefined ? { url: sfUrl } : {}),
      ...(id !== undefined ? { slackFileId: id } : {}),
    }
  }
  return undefined
}

function imageFromAttachment(a: Record<string, unknown>): InboundImage | undefined {
  const url = str(a.image_url) ?? str(a.thumb_url)
  if (url === undefined) return undefined
  const label = cleanMediaLabel(str(a.title) ?? str(a.fallback) ?? '') || 'image'
  return {
    kind: 'legacy_attachment',
    label,
    isGif: looksLikeGif(url, a.service_name),
    url,
  }
}

/** Every image carried by top-level `image` blocks and legacy `attachments`
 *  entries with an `image_url` / `thumb_url`. Nested image elements (section
 *  accessories, context icons) are decoration on cards and are not counted. */
export function extractInboundImages(msg: Record<string, unknown>): InboundImage[] {
  const out: InboundImage[] = []
  const blocks = Array.isArray(msg.blocks) ? msg.blocks : []
  for (const b of blocks) {
    if (b && typeof b === 'object' && (b as Record<string, unknown>).type === 'image') {
      const img = imageFromBlock(b as Record<string, unknown>)
      if (img) out.push(img)
    }
  }
  const atts = Array.isArray(msg.attachments) ? msg.attachments : []
  for (const a of atts) {
    if (a && typeof a === 'object') {
      const img = imageFromAttachment(a as Record<string, unknown>)
      if (img) out.push(img)
    }
  }
  return out
}

/** The text line for one image: `[GIF: label]` or `[image: label]`. */
export function mediaLine(img: InboundImage): string {
  return `[${img.isGif ? 'GIF' : 'image'}: ${img.label}]`
}

/** Describe every attachment of a message (Slack `files` + images in
 *  blocks/attachments). `cleanName` is the caller's filename sanitizer. */
export function describeInboundMedia(
  msg: Record<string, unknown>,
  cleanName: (name: string) => string,
): InboundMediaSummary {
  const entries: InboundMediaEntry[] = []
  const files = Array.isArray(msg.files) ? (msg.files as Array<Record<string, unknown>>) : []
  for (const f of files) {
    const name = cleanName(str(f?.name) ?? 'unnamed')
    entries.push({
      kind: 'file',
      description: `${name} (${str(f?.mimetype) ?? 'unknown'}, ${f?.size ?? '?'} bytes)`,
    })
  }
  const images = extractInboundImages(msg)
  const lines = images.map(mediaLine)
  for (const [i, img] of images.entries()) {
    entries.push({ kind: img.kind, description: lines[i]! })
  }
  return { lines, count: entries.length, entries }
}

/** `kind=…: description; …` for the single-string `attachments` meta attr. */
export function formatMediaEntries(entries: InboundMediaEntry[]): string {
  return entries.map((e) => `kind=${e.kind}: ${e.description}`).join('; ')
}

/** Message text with one media line per image appended (empty text → just
 *  the lines). */
export function textWithMediaLines(text: string, lines: string[]): string {
  if (lines.length === 0) return text
  const extra = lines.join('\n')
  return text.length > 0 ? `${text}\n${extra}` : extra
}

/** deliverEvent's media meta: `attachment_count` (files + images) and
 *  `attachments` (each entry prefixed with its kind), plus the image lines to
 *  append to the delivered text. */
export function inboundMediaMeta(
  ev: Record<string, unknown>,
  cleanName: (name: string) => string,
): { meta: Record<string, string>; lines: string[] } {
  const media = describeInboundMedia(ev, cleanName)
  const meta: Record<string, string> = {}
  if (media.count > 0) {
    meta.attachment_count = String(media.count)
    meta.attachments = formatMediaEntries(media.entries)
  }
  return { meta, lines: media.lines }
}

/** One fetch_messages entry. Images carried in blocks / legacy attachments
 *  (GIF picker, /giphy) add `[GIF: …]` lines to `text` and count in
 *  `attachment_count`, each `attachments` entry with its kind. */
export async function formatFetchedMessage(
  // biome-ignore lint/suspicious/noExplicitAny: raw Slack message
  m: any,
  resolveName: (userId: string) => Promise<string>,
  cleanName: (name: string) => string,
): Promise<Record<string, unknown>> {
  const userName = m.user ? await resolveName(m.user) : 'unknown'
  const media = describeInboundMedia(m, cleanName)
  return {
    ts: m.ts,
    user: userName,
    user_id: m.user,
    text: textWithMediaLines(typeof m.text === 'string' ? m.text : '', media.lines),
    thread_ts: m.thread_ts,
    // biome-ignore lint/suspicious/noExplicitAny: raw Slack file
    files: m.files?.map((f: any) => ({
      name: f.name,
      mimetype: f.mimetype,
      size: f.size,
    })),
    ...(media.count > 0 ? { attachment_count: media.count, attachments: media.entries } : {}),
  }
}

// ---------------------------------------------------------------------------
// Safe download
// ---------------------------------------------------------------------------

/** Exactly https://files.slack.com — the only host that ever gets the token. */
export function isSlackFilesHost(url: URL): boolean {
  return url.protocol === 'https:' && url.hostname === 'files.slack.com'
}

function v4Octets(ip: string): number[] | undefined {
  const parts = ip.split('.')
  if (parts.length !== 4) return undefined
  const n = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN))
  return n.every((x) => x >= 0 && x <= 255) ? n : undefined
}

function isPrivateV4(o: number[]): boolean {
  const [a, b] = o as [number, number, number, number]
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && o[2] === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

/** Expand an IPv6 literal to 8 hextets, or undefined if it is not one. */
function v6Hextets(ip: string): number[] | undefined {
  let s = ip.toLowerCase()
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  let tail: number[] = []
  const lastColon = s.lastIndexOf(':')
  const maybeV4 = s.slice(lastColon + 1)
  if (maybeV4.includes('.')) {
    const o = v4Octets(maybeV4)
    if (!o) return undefined
    tail = [(o[0]! << 8) | o[1]!, (o[2]! << 8) | o[3]!]
    s = `${s.slice(0, lastColon + 1)}0:0`
  }
  const halves = s.split('::')
  if (halves.length > 2) return undefined
  const parse = (h: string): number[] | undefined => {
    if (h === '') return []
    const out: number[] = []
    for (const p of h.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(p)) return undefined
      out.push(Number.parseInt(p, 16))
    }
    return out
  }
  const head = parse(halves[0]!)
  const rest = halves.length === 2 ? parse(halves[1]!) : []
  if (!head || !rest) return undefined
  const fill = 8 - head.length - rest.length
  if (halves.length === 2 ? fill < 1 : fill !== 0) return undefined
  const all = [...head, ...new Array(fill).fill(0), ...rest]
  if (tail.length === 2) {
    all[6] = tail[0]!
    all[7] = tail[1]!
  }
  return all
}

/** True for loopback, private, link-local, CGNAT, multicast, reserved,
 *  unspecified, ULA, IPv4-mapped/NAT64 forms of those — and for anything that
 *  does not parse (fail closed). */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip.split('%')[0] ?? '')
  if (kind === 4) {
    const o = v4Octets(ip)
    return o === undefined || isPrivateV4(o)
  }
  if (kind !== 6) return true
  const h = v6Hextets(ip)
  if (!h) return true
  const [h0, , , , , h5] = h as [number, number, number, number, number, number, number, number]
  const embeddedV4 = [h[6]! >> 8, h[6]! & 0xff, h[7]! >> 8, h[7]! & 0xff]
  if (h.every((x) => x === 0)) return true // ::
  if (h.slice(0, 7).every((x) => x === 0) && h[7] === 1) return true // ::1
  if (h.slice(0, 5).every((x) => x === 0) && h5 === 0xffff) return isPrivateV4(embeddedV4) // ::ffff:a.b.c.d
  if (h.slice(0, 6).every((x) => x === 0)) return true // ::a.b.c.d (deprecated compat)
  if (h0 === 0x64 && h[1] === 0xff9b) return true // NAT64 64:ff9b::/96
  if ((h0 & 0xfe00) === 0xfc00) return true // fc00::/7 ULA
  if ((h0 & 0xffc0) === 0xfe80) return true // fe80::/10 link-local
  if ((h0 & 0xffc0) === 0xfec0) return true // fec0::/10 site-local
  if ((h0 & 0xff00) === 0xff00) return true // multicast
  if (h0 === 0x2001 && h[1] === 0x0db8) return true // documentation
  return false
}

export const INBOUND_IMAGE_MAX_BYTES = 15 * 1024 * 1024
export const INBOUND_IMAGE_MAX_REDIRECTS = 3
const RASTER_IMAGE_TYPES = new Set([
  'image/gif',
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/heic',
  'image/heif',
])

export interface FetchImageDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  /** Every address `host` resolves to (A + AAAA). */
  lookup: (host: string) => Promise<string[]>
  /** Sent ONLY to https://files.slack.com, ONLY when the download started there. */
  botToken: string
}

export interface FetchImageOptions {
  maxBytes?: number
  maxRedirects?: number
  timeoutMs?: number
}

export interface FetchedImage {
  bytes: Buffer
  contentType: string
  finalUrl: string
}

/** Refuses with a short reason that never contains the token. */
export class ImageFetchRefused extends Error {}

async function assertPublicHost(url: URL, deps: FetchImageDeps): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (isIP(host) !== 0) {
    if (isPrivateAddress(host)) throw new ImageFetchRefused(`refused private address ${host}`)
    return
  }
  if (/^localhost$|\.localhost$|\.local$|\.internal$/i.test(host)) {
    throw new ImageFetchRefused(`refused local host ${host}`)
  }
  let addrs: string[]
  try {
    addrs = await deps.lookup(host)
  } catch {
    throw new ImageFetchRefused(`could not resolve ${host}`)
  }
  if (addrs.length === 0) throw new ImageFetchRefused(`could not resolve ${host}`)
  for (const a of addrs) {
    if (isPrivateAddress(a)) throw new ImageFetchRefused(`refused ${host}: resolves to a private address`)
  }
}

function checkUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ImageFetchRefused('invalid image URL')
  }
  if (url.protocol !== 'https:') throw new ImageFetchRefused('refused non-https image URL')
  if (url.username !== '' || url.password !== '') {
    throw new ImageFetchRefused('refused image URL with credentials')
  }
  return url
}

async function readCapped(resp: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(resp.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ImageFetchRefused(`image is ${declared} bytes, over the ${maxBytes}-byte cap`)
  }
  if (!resp.body) return Buffer.alloc(0)
  const reader = resp.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => {})
      throw new ImageFetchRefused(`image is over the ${maxBytes}-byte cap`)
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

/** Download one inbound image URL under the token-host rule (see file
 *  header). Throws `ImageFetchRefused` on any refusal. */
export async function fetchInboundImage(
  rawUrl: string,
  deps: FetchImageDeps,
  opts: FetchImageOptions = {},
): Promise<FetchedImage> {
  const maxBytes = opts.maxBytes ?? INBOUND_IMAGE_MAX_BYTES
  const maxRedirects = opts.maxRedirects ?? INBOUND_IMAGE_MAX_REDIRECTS
  let url = checkUrl(rawUrl)
  // The token may only follow a download that STARTED on files.slack.com; an
  // outside URL that redirects to Slack is fetched without it.
  const slackOrigin = isSlackFilesHost(url)
  for (let hop = 0; ; hop++) {
    const sendToken = slackOrigin && isSlackFilesHost(url)
    if (!sendToken) await assertPublicHost(url, deps)
    const headers: Record<string, string> = { Accept: 'image/*' }
    if (sendToken) headers.Authorization = `Bearer ${deps.botToken}`
    const resp = await deps.fetch(url.toString(), {
      method: 'GET',
      headers,
      redirect: 'manual',
      credentials: 'omit',
      ...(opts.timeoutMs !== undefined ? { signal: AbortSignal.timeout(opts.timeoutMs) } : {}),
    })
    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location')
      if (!loc) throw new ImageFetchRefused(`redirect ${resp.status} with no location`)
      if (hop >= maxRedirects) throw new ImageFetchRefused('too many redirects')
      let next: string
      try {
        next = new URL(loc, url).toString()
      } catch {
        throw new ImageFetchRefused('invalid redirect location')
      }
      url = checkUrl(next)
      continue
    }
    if (!resp.ok) throw new ImageFetchRefused(`HTTP ${resp.status}`)
    const contentType = (resp.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    if (!RASTER_IMAGE_TYPES.has(contentType)) {
      throw new ImageFetchRefused(`refused content-type ${contentType || '(none)'}`)
    }
    const bytes = await readCapped(resp, maxBytes)
    return { bytes, contentType, finalUrl: url.toString() }
  }
}

const EXT_BY_TYPE: Record<string, string> = {
  'image/gif': 'gif',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/heic': 'heic',
  'image/heif': 'heif',
}

/** `<index>_<label>.<ext>` with only [A-Za-z0-9._-] in the label part, capped,
 *  extension from the verified content-type (never from the URL). */
export function inboundImageFilename(label: string, contentType: string, index: number): string {
  const base =
    label
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .replace(/\.{2,}/g, '_')
      .replace(/^[._]+|[._]+$/g, '')
      .slice(0, 60) || 'image'
  return `${index}_${base}.${EXT_BY_TYPE[contentType] ?? 'img'}`
}
