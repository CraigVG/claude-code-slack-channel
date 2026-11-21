/**
 * private-image-blocks.ts — inline images in Block Kit cards from LOCAL files,
 * without sharing the file into any channel.
 *
 * A reply/edit block may carry an image element whose `slack_file` names a
 * local path instead of a Slack file id:
 *
 *   { "type": "image", "slack_file": { "path": "/abs/chart.png" }, "alt_text": "chart" }
 *
 * `resolvePrivateImageBlocks` finds every such element (top-level image
 * blocks, section accessories, context elements: any nested object of
 * `type: "image"`), runs the same outbound guards the reply tool's `files`
 * get (SLACK_SENDABLE_ROOTS allowlist + denylist, secret-value scan of the
 * bytes and the filename), uploads the bytes PRIVATELY (no `channel_id`, so
 * the file is never shared to a channel and posts no message of its own),
 * waits until Slack has processed each file, and returns a copy of the blocks
 * with `slack_file: { id }` in place of each path.
 *
 * Why the wait: Slack processes an upload asynchronously. An image block that
 * references a file Slack has not finished processing is rejected or renders
 * as a broken image. We poll `files.info` until the file reports image
 * dimensions or a thumbnail, and refuse to return (so the card is never
 * posted) if it is not ready within the deadline.
 *
 * Pure module: every Slack and fs effect is injected, so it is unit-tested
 * against fakes and imports no SDK.
 */

/** Effects injected by server.ts (production) or tests (fakes). */
export interface PrivateImageDeps {
  /** Read `path` ONCE, run the outbound file guards on those bytes (path
   *  allowlist/denylist + secret-value scan of content and filename) and return
   *  them. Throws on a block (the implementation journals it first). */
  readAndGuard(path: string, filename: string): Uint8Array
  /** Upload the files in ONE call WITHOUT a channel (private, unshared) and
   *  return their Slack file ids in the given order. */
  uploadPrivate(files: Array<{ bytes: Uint8Array; filename: string }>): Promise<string[]>
  /** `files.info` for one id → the `file` object (or undefined). */
  fileInfo(id: string): Promise<Record<string, unknown> | undefined>
  sleep(ms: number): Promise<void>
  /** Wall clock (epoch ms) for the readiness deadline. Default `Date.now`. */
  now?(): number
}

export interface ResolveOptions {
  /** Waits between `files.info` polls, in order; the last value repeats until
   *  `maxWaitMs` is spent. */
  pollDelaysMs?: number[]
  /** Total time budget for ALL files to become ready, enforced both as
   *  wall-clock time and as total poll-sleep time (whichever runs out first). */
  maxWaitMs?: number
}

const DEFAULT_POLL_DELAYS_MS = [250, 500, 1000, 2000]
const DEFAULT_MAX_WAIT_MS = 20_000
/** Formats Slack renders in an image block. Checked before upload so a wrong
 *  file type fails fast instead of uploading and then timing out. */
const IMAGE_EXT_RE = /\.(png|jpe?g|gif)$/i

type ImageRef = { node: Record<string, unknown>; path: string }

function basenameOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

/** Every image element whose `slack_file` carries a local `path`. Throws if
 *  such a `slack_file` also carries `id` or `url` (ambiguous), or the path is
 *  not an absolute path to a png/jpg/gif. */
export function findLocalImageRefs(blocks: unknown): ImageRef[] {
  const refs: ImageRef[] = []
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x)
      return
    }
    if (v === null || typeof v !== 'object') return
    const node = v as Record<string, unknown>
    const sf = node.slack_file as Record<string, unknown> | undefined
    if (node.type === 'image' && sf !== null && typeof sf === 'object' && 'path' in sf) {
      const path = sf.path
      if (typeof path !== 'string' || !path.startsWith('/')) {
        throw new Error('image slack_file.path must be an absolute path')
      }
      if ('id' in sf || 'url' in sf) {
        throw new Error('image slack_file takes ONE of path, id or url')
      }
      if (!IMAGE_EXT_RE.test(path)) {
        throw new Error(`image slack_file.path must be a .png, .jpg, .jpeg or .gif file: ${basenameOf(path)}`)
      }
      refs.push({ node, path })
    }
    for (const child of Object.values(node)) walk(child)
  }
  walk(blocks)
  return refs
}

/** True once Slack has processed an uploaded image far enough to render it. */
export function isImageReady(file: Record<string, unknown> | undefined): boolean {
  if (file === undefined) return false
  if (typeof file.original_w === 'number' && file.original_w > 0) return true
  return Object.keys(file).some((k) => k.startsWith('thumb_') && typeof file[k] === 'string')
}

const NOT_YET = Symbol('not-yet')

/** `p`, or NOT_YET once `ms` of REAL time pass. A stalled call can never hold
 *  the caller past its deadline; its late answer is ignored (and a late
 *  rejection is swallowed). */
function within<T>(p: Promise<T>, ms: number): Promise<T | typeof NOT_YET> {
  return new Promise((resolveValue) => {
    const timer = setTimeout(() => resolveValue(NOT_YET), Math.max(0, ms))
    p.then(
      (v) => {
        clearTimeout(timer)
        resolveValue(v)
      },
      () => {
        clearTimeout(timer)
        resolveValue(NOT_YET)
      },
    )
  })
}

/** Poll `files.info` until the file is ready, never past `deadline` (epoch
 *  ms, wall clock — PR #5 review: the budget used to count sleep time only, so
 *  a slow or stalled `files.info` could outlive it). Each call and each sleep
 *  is cut to the time left. A transient error counts as "not ready yet". */
async function waitUntilReady(
  id: string,
  deps: PrivateImageDeps,
  delays: number[],
  deadline: number,
  budget: number,
  spent: { sleptMs: number },
): Promise<void> {
  const now = deps.now ?? Date.now
  const notReady = () =>
    new Error(
      `image ${id} was not processed by Slack within ${budget}ms; the card was not posted (retry the reply)`,
    )
  for (let attempt = 0; ; attempt++) {
    const left = deadline - now()
    if (left <= 0) throw notReady()
    const file = await within(deps.fileInfo(id), left)
    if (file !== NOT_YET && isImageReady(file) && now() <= deadline) return
    const delay = delays[Math.min(attempt, delays.length - 1)] ?? 1000
    const leftAfter = deadline - now()
    if (delay >= leftAfter || spent.sleptMs + delay > budget) throw notReady()
    await within(deps.sleep(delay), leftAfter)
    spent.sleptMs += delay
  }
}

/** Upload every local-path image privately, wait until Slack can render each,
 *  and return a deep copy of `blocks` with `slack_file: { id }` in their place.
 *  Blocks without local-path images are returned unchanged (same reference).
 *  The same path used twice uploads once. Nothing is uploaded if any guard
 *  blocks. */
export async function resolvePrivateImageBlocks<T>(
  blocks: T,
  deps: PrivateImageDeps,
  opts: ResolveOptions = {},
): Promise<T> {
  if (findLocalImageRefs(blocks).length === 0) return blocks
  const copy = structuredClone(blocks)
  const refs = findLocalImageRefs(copy)
  const paths = [...new Set(refs.map((r) => r.path))]
  // Guard every file before uploading any of them.
  const files = paths.map((path) => {
    const filename = basenameOf(path)
    return { bytes: deps.readAndGuard(path, filename), filename }
  })
  const ids = await deps.uploadPrivate(files)
  const idByPath = new Map<string, string>()
  for (const [i, path] of paths.entries()) {
    const id = ids[i]
    if (!id) throw new Error(`private upload returned no file id for ${basenameOf(path)}`)
    idByPath.set(path, id)
  }
  // ONE wall-clock budget for all images together, starting after the upload.
  const budget = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
  const delays = opts.pollDelaysMs ?? DEFAULT_POLL_DELAYS_MS
  const deadline = (deps.now ?? Date.now)() + budget
  const spent = { sleptMs: 0 }
  for (const id of idByPath.values()) {
    await waitUntilReady(id, deps, delays, deadline, budget, spent)
  }
  for (const ref of refs) ref.node.slack_file = { id: idByPath.get(ref.path) }
  return copy
}

/** Minimal Slack client surface used by `createPrivateImageDeps`. */
export interface PrivateImageClient {
  filesUploadV2(args: Record<string, unknown>): Promise<unknown>
  files: { info(args: { file: string }): Promise<{ file?: Record<string, unknown> }> }
}

/** Production `PrivateImageDeps` bound to a Slack client and the reply tool's
 *  outbound guards. fs and the guards are injected so this stays testable.
 *  A guard hit is journaled (`journalExfilBlock`) and rethrown. */
export function createPrivateImageDeps(deps: {
  client: PrivateImageClient
  assertSendable: (path: string) => void
  assertNoSecretValues: (text: string) => void
  journalExfilBlock: (reason: string) => void
  readFile: (path: string) => Uint8Array
  sleep?: (ms: number) => Promise<void>
}): PrivateImageDeps {
  const guarded = (fn: () => void): void => {
    try {
      fn()
    } catch (err) {
      deps.journalExfilBlock(err instanceof Error ? err.message : String(err))
      throw err
    }
  }
  return {
    readAndGuard(path, filename) {
      guarded(() => deps.assertSendable(path))
      const bytes = deps.readFile(path)
      guarded(() => deps.assertNoSecretValues(Buffer.from(bytes).toString('latin1')))
      guarded(() => deps.assertNoSecretValues(filename))
      return bytes
    },
    async uploadPrivate(files) {
      // No channel_id / channels / thread_ts: the files stay private to the bot
      // and post no message; the card's image block is their only appearance.
      const res = await deps.client.filesUploadV2({
        file_uploads: files.map((f) => ({ file: Buffer.from(f.bytes), filename: f.filename })),
      })
      const r = res as { files?: Array<{ id?: string; files?: Array<{ id?: string }> }> }
      const ids = (r.files ?? []).flatMap((c) =>
        c.files ? c.files.map((f) => f.id ?? '') : [c.id ?? ''],
      )
      return files.map((_, i) => ids[i] ?? '')
    },
    async fileInfo(id) {
      return (await deps.client.files.info({ file: id })).file
    },
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  }
}
