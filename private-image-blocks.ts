/**
 * private-image-blocks.ts — inline images in Block Kit cards from LOCAL files,
 * shared into the card's channel and thread so every channel member can see them.
 *
 * A reply/edit block may carry an image element whose `slack_file` names a
 * local path instead of a Slack file id:
 *
 *   { "type": "image", "slack_file": { "path": "/abs/chart.png" }, "alt_text": "chart" }
 *
 * `resolveImageBlocksWithCleanup` / `resolvePrivateImageBlocks` finds every
 * such element (top-level image blocks, section accessories, context elements:
 * any nested object of `type: "image"`), runs the same outbound guards the
 * reply tool's `files` get (SLACK_SENDABLE_ROOTS allowlist + denylist,
 * secret-value scan of the bytes and the filename), uploads the bytes in ONE
 * `filesUploadV2` call shared into the SAME `channel_id` (and `thread_ts`, when
 * in a thread) as the card, waits until Slack has processed each file, and
 * returns a copy of the blocks with `slack_file: { id }` in place of each path.
 *
 * Rollback on failure: because `filesUploadV2` shares the files before
 * readiness polling and before Slack accepts the card post/edit, any failure
 * after upload (missing file id, readiness polling timeout, or a rejected card
 * post/edit) deletes every newly uploaded file via `files.delete` so no
 * standalone orphan share is left behind and a retry does not create a
 * duplicate. Pre-existing `slack_file: { id }` references and already-posted
 * or durably-queued cards are never deleted.
 *
 * Edit target resolution: before `edit_message` uploads local images,
 * `resolveEditImageTarget` fetches the existing card from Slack via
 * `conversations.replies` to establish its channel, real parent `thread_ts`,
 * and editability (exists, not deleted/hidden, owned by this bot). It fails
 * closed if any of those cannot be established or if a caller-supplied
 * `thread_ts` disagrees with the card's actual parent thread.
 *
 * Why share into the card's channel/thread: per Slack's `files.completeUploadExternal`
 * and `slack_file` docs, omitting `channel_id` leaves the uploaded file private
 * to the uploader (the bot), and `slack_file` image blocks are visibility-gated —
 * viewers only see the image if they have access to the underlying file. Sharing
 * into the card's conversation grants access to every member of that channel.
 *
 * Why the wait: Slack processes an upload asynchronously. An image block that
 * references a file Slack has not finished processing is rejected or renders
 * as a broken image. We poll `files.info` until the file reports image
 * dimensions or a thumbnail, and refuse to return (cleaning up the uploaded
 * shares so the card is never posted and retries stay clean) if it is not ready
 * within the deadline.
 *
 * Pure module: every Slack and fs effect is injected, so it is unit-tested
 * against fakes and imports no SDK.
 */

/** Destination conversation where card images must be shared so channel
 *  members have access to render `slack_file` image blocks. */
export interface ImageUploadTarget {
  channelId: string
  threadTs?: string
}

/** Resolved blocks together with an idempotent rollback handle that deletes
 *  every file uploaded during resolution if the subsequent card post/edit fails. */
export interface ResolvedImageBlocks<T> {
  blocks: T
  uploadedIds: string[]
  /** Best-effort idempotent deletion of every file uploaded by this resolution.
   *  Never throws (a delete failure on one file still deletes the rest and
   *  never masks the primary post/edit/timeout error). */
  cleanup(): Promise<void>
}

/** Effects injected by server.ts (production) or tests (fakes). */
export interface PrivateImageDeps {
  /** Read `path` ONCE, run the outbound file guards on those bytes (path
   *  allowlist/denylist + secret-value scan of content and filename) and return
   *  them. Throws on a block (the implementation journals it first). */
  readAndGuard(path: string, filename: string): Uint8Array
  /** Upload all card images in ONE call shared into `target.channelId` (and
   *  `target.threadTs` when in a thread) and return their Slack file ids in the
   *  given order. */
  uploadMany(
    files: Array<{ bytes: Uint8Array; filename: string }>,
    target: ImageUploadTarget,
  ): Promise<string[]>
  /** `files.info` for one id → the `file` object (or undefined). */
  fileInfo(id: string): Promise<Record<string, unknown> | undefined>
  /** `files.delete` for one id, used to roll back newly uploaded shares when
   *  readiness polling times out or Slack rejects the card post/edit. */
  deleteFile(id: string): Promise<void>
  sleep(ms: number): Promise<void>
}

export interface ResolveOptions {
  /** Waits between `files.info` polls, in order; the last value repeats until
   *  `maxWaitMs` is spent. */
  pollDelaysMs?: number[]
  /** Total time budget for one file to become ready. */
  maxWaitMs?: number
}

/** Minimal Slack message metadata returned by `conversations.replies`. */
export interface SlackMessageMeta {
  ts?: string
  thread_ts?: string
  channel?: string
  user?: string
  bot_id?: string
  subtype?: string
  hidden?: boolean
}

/** Minimal Slack client surface used to resolve an edited card's real thread
 *  and editability before uploading inline images. */
export interface EditTargetLookupClient {
  conversations: {
    replies(args: {
      channel: string
      ts: string
      oldest: string
      latest: string
      inclusive: boolean
      limit: number
    }): Promise<{ messages?: SlackMessageMeta[] }>
  }
}

/** Bot identity from `auth.test()`, used to verify the bot authored a message
 *  before uploading files on its behalf. */
export interface BotIdentity {
  botUserId: string
  selfBotId: string
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

function isBotOwnedMessage(msg: SlackMessageMeta, identity: BotIdentity): boolean {
  return (
    (identity.selfBotId !== '' && msg.bot_id === identity.selfBotId) ||
    (identity.botUserId !== '' && msg.user === identity.botUserId)
  )
}

function makeCleanup(
  uploadedIds: readonly string[],
  deleteFile: (id: string) => Promise<void>,
): () => Promise<void> {
  let cleaned = false
  return async () => {
    if (cleaned || uploadedIds.length === 0) return
    cleaned = true
    for (const id of uploadedIds) {
      try {
        await deleteFile(id)
      } catch {
        // Best-effort rollback: never skip remaining ids or mask the primary error.
      }
    }
  }
}

/** Resolve the real channel, parent thread, and editability of the target card
 *  before `edit_message` uploads inline images. Fails closed if the card cannot
 *  be fetched, is missing/deleted/hidden, belongs to another channel, was not
 *  authored by this bot, or disagrees with a caller-supplied `thread_ts`. */
export async function resolveEditImageTarget(opts: {
  client: EditTargetLookupClient
  chatId: string
  messageId: string
  callerThreadTs?: string
  identity: BotIdentity
}): Promise<ImageUploadTarget> {
  if (!opts.chatId || !opts.messageId) {
    throw new Error('edit_message: chat_id and message_id are required to resolve the target card')
  }
  if (!opts.identity.botUserId && !opts.identity.selfBotId) {
    throw new Error('edit_message: bot identity is not resolved yet; retry once Slack auth settles')
  }
  let res: { messages?: SlackMessageMeta[] }
  try {
    res = await opts.client.conversations.replies({
      channel: opts.chatId,
      ts: opts.messageId,
      oldest: opts.messageId,
      latest: opts.messageId,
      inclusive: true,
      limit: 1,
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    throw new Error(
      `edit_message: failed to verify target card ${opts.messageId} in ${opts.chatId}: ${detail}`,
    )
  }
  const message = res.messages?.find((m) => m.ts === opts.messageId)
  if (!message) {
    throw new Error(
      `edit_message: target card ${opts.messageId} was not found in ${opts.chatId}`,
    )
  }
  if (typeof message.channel === 'string' && message.channel !== opts.chatId) {
    throw new Error(
      `edit_message: target card ${opts.messageId} belongs to channel ${message.channel}, not ${opts.chatId}`,
    )
  }
  if (
    message.hidden === true ||
    message.subtype === 'tombstone' ||
    message.subtype === 'message_deleted'
  ) {
    throw new Error(
      `edit_message: target card ${opts.messageId} is deleted or hidden and cannot be edited`,
    )
  }
  if (!isBotOwnedMessage(message, opts.identity)) {
    throw new Error(
      `edit_message: target card ${opts.messageId} is not authored by this bot and cannot be edited`,
    )
  }
  const actualThreadTs =
    typeof message.thread_ts === 'string' && message.thread_ts.length > 0
      ? message.thread_ts
      : undefined
  if (opts.callerThreadTs !== undefined && opts.callerThreadTs !== actualThreadTs) {
    throw new Error(
      actualThreadTs !== undefined
        ? `edit_message: thread_ts ${opts.callerThreadTs} does not match target card ${opts.messageId}'s thread ${actualThreadTs}`
        : `edit_message: thread_ts ${opts.callerThreadTs} was provided, but target card ${opts.messageId} is a top-level message`,
    )
  }
  return actualThreadTs !== undefined
    ? { channelId: opts.chatId, threadTs: actualThreadTs }
    : { channelId: opts.chatId }
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
        throw new Error(
          `image slack_file.path must be a .png, .jpg, .jpeg or .gif file: ${basenameOf(path)}`,
        )
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

async function waitUntilReady(
  id: string,
  deps: PrivateImageDeps,
  opts: ResolveOptions,
): Promise<void> {
  const delays = opts.pollDelaysMs ?? DEFAULT_POLL_DELAYS_MS
  const budget = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
  let waited = 0
  for (let attempt = 0; ; attempt++) {
    let file: Record<string, unknown> | undefined
    try {
      file = await deps.fileInfo(id)
    } catch {
      file = undefined // a transient files.info error counts as "not ready yet"
    }
    if (isImageReady(file)) return
    const delay = delays[Math.min(attempt, delays.length - 1)] ?? 1000
    if (waited + delay > budget) {
      throw new Error(
        `image ${id} was not processed by Slack within ${budget}ms; the card was not posted (retry the reply)`,
      )
    }
    await deps.sleep(delay)
    waited += delay
  }
}

/** Upload every local-path image into the card's channel/thread in one batch,
 *  wait until Slack can render each, and return a deep copy of `blocks` with
 *  `slack_file: { id }` in their place alongside a `cleanup()` callback to
 *  delete the newly uploaded files if the subsequent card post/edit fails.
 *  If any file id is missing or readiness polling times out, every uploaded
 *  file is deleted before throwing so no standalone share is left behind. */
export async function resolveImageBlocksWithCleanup<T>(
  blocks: T,
  deps: PrivateImageDeps,
  target: ImageUploadTarget,
  opts: ResolveOptions = {},
): Promise<ResolvedImageBlocks<T>> {
  if (findLocalImageRefs(blocks).length === 0) {
    return { blocks, uploadedIds: [], cleanup: async () => {} }
  }
  if (!target.channelId) {
    throw new Error('inline image upload requires a channelId so channel members can view it')
  }
  const copy = structuredClone(blocks)
  const refs = findLocalImageRefs(copy)
  const paths = [...new Set(refs.map((r) => r.path))]
  // Guard every file before uploading any of them.
  const files = paths.map((path) => {
    const filename = basenameOf(path)
    return { bytes: deps.readAndGuard(path, filename), filename }
  })
  const ids = await deps.uploadMany(files, target)
  const uploadedIds = ids.filter((id): id is string => typeof id === 'string' && id.length > 0)
  const cleanup = makeCleanup(uploadedIds, deps.deleteFile)
  try {
    const idByPath = new Map<string, string>()
    for (const [i, path] of paths.entries()) {
      const id = ids[i]
      if (!id) throw new Error(`image upload returned no file id for ${basenameOf(path)}`)
      idByPath.set(path, id)
    }
    for (const id of idByPath.values()) await waitUntilReady(id, deps, opts)
    for (const ref of refs) ref.node.slack_file = { id: idByPath.get(ref.path) }
    return { blocks: copy, uploadedIds, cleanup }
  } catch (err) {
    await cleanup()
    throw err
  }
}

/** Upload every local-path image into the card's channel/thread in one batch,
 *  wait until Slack can render each, and return a deep copy of `blocks` with
 *  `slack_file: { id }` in their place. Blocks without local-path images are
 *  returned unchanged (same reference). The same path used twice uploads once.
 *  Nothing is uploaded if any guard blocks, and any uploaded share is deleted
 *  if a file id is missing or readiness polling times out. */
export async function resolvePrivateImageBlocks<T>(
  blocks: T,
  deps: PrivateImageDeps,
  target: ImageUploadTarget,
  opts: ResolveOptions = {},
): Promise<T> {
  return (await resolveImageBlocksWithCleanup(blocks, deps, target, opts)).blocks
}

/** Resolve local-path images into `target` and pass the resolved blocks to
 *  `send`. If `send` rejects, every newly uploaded file is deleted via
 *  `cleanup()` so no standalone share is left behind and a retry stays clean. */
export async function withResolvedImageBlocks<T, R>(
  blocks: T,
  deps: PrivateImageDeps,
  target: ImageUploadTarget,
  send: (resolvedBlocks: T) => Promise<R>,
  opts: ResolveOptions = {},
): Promise<R> {
  const resolved = await resolveImageBlocksWithCleanup(blocks, deps, target, opts)
  try {
    return await send(resolved.blocks)
  } catch (err) {
    await resolved.cleanup()
    throw err
  }
}

/** Full edit-with-inline-images orchestration:
 *  - When `blocks` has no local-path images, calls `applyEdit` directly without
 *    extra Slack lookups.
 *  - When `blocks` has local-path images, resolves the target card's real
 *    channel, parent thread, and editability via `resolveEditImageTarget`
 *    (failing closed before any read/upload), optionally re-validates the
 *    resolved target against the outbound gate, uploads into that resolved
 *    target, and rolls back the newly uploaded files if readiness times out or
 *    `applyEdit` (`chat.update`) rejects. */
export async function resolveAndApplyEditWithImages<T, R>(opts: {
  blocks: T | undefined
  chatId: string
  messageId: string
  callerThreadTs?: string
  identity: BotIdentity
  lookupClient: EditTargetLookupClient
  imageDeps: PrivateImageDeps
  assertResolvedTargetAllowed?: (target: ImageUploadTarget) => void
  applyEdit: (blocks: T | undefined, resolvedTarget: ImageUploadTarget) => Promise<R>
  resolveOpts?: ResolveOptions
}): Promise<R> {
  if (opts.blocks === undefined || findLocalImageRefs(opts.blocks).length === 0) {
    const passthroughTarget: ImageUploadTarget =
      opts.callerThreadTs !== undefined
        ? { channelId: opts.chatId, threadTs: opts.callerThreadTs }
        : { channelId: opts.chatId }
    return opts.applyEdit(opts.blocks, passthroughTarget)
  }
  const target = await resolveEditImageTarget({
    client: opts.lookupClient,
    chatId: opts.chatId,
    messageId: opts.messageId,
    callerThreadTs: opts.callerThreadTs,
    identity: opts.identity,
  })
  opts.assertResolvedTargetAllowed?.(target)
  return withResolvedImageBlocks(
    opts.blocks,
    opts.imageDeps,
    target,
    (resolvedBlocks) => opts.applyEdit(resolvedBlocks, target),
    opts.resolveOpts,
  )
}

/** Minimal Slack client surface used by `createPrivateImageDeps`. */
export interface PrivateImageClient {
  filesUploadV2(args: Record<string, unknown>): Promise<unknown>
  files: {
    info(args: { file: string }): Promise<{ file?: Record<string, unknown> }>
    delete(args: { file: string }): Promise<unknown>
  }
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
    async uploadMany(files, target) {
      if (!target.channelId) {
        throw new Error('inline image upload requires a channelId so channel members can view it')
      }
      // Share into the card's channel (and thread, when present) in ONE call so
      // every member of the conversation can view the `slack_file` image blocks.
      const uploadArgs: Record<string, unknown> = {
        channel_id: target.channelId,
        file_uploads: files.map((f) => ({ file: Buffer.from(f.bytes), filename: f.filename })),
      }
      if (target.threadTs) uploadArgs.thread_ts = target.threadTs
      const res = await deps.client.filesUploadV2(uploadArgs)
      const r = res as { files?: Array<{ id?: string; files?: Array<{ id?: string }> }> }
      const ids = (r.files ?? []).flatMap((c) =>
        c.files ? c.files.map((f) => f.id ?? '') : [c.id ?? ''],
      )
      return files.map((_, i) => ids[i] ?? '')
    },
    async fileInfo(id) {
      return (await deps.client.files.info({ file: id })).file
    },
    async deleteFile(id) {
      await deps.client.files.delete({ file: id })
    },
    sleep: deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  }
}
