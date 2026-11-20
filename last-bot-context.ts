import type { WebClient } from '@slack/web-api'
import type { GateResult } from './lib.ts'

const MAX_CONVERSATIONS = 256
const MAX_CONTEXT_CHARS = 300
const HISTORY_LIMIT = 5

type BotMessage = { ts: string; text: string }
type HistoryMessage = Partial<BotMessage> & { user?: string; bot_id?: string }
type BotIdentity = { userId: string; botId: string }
type ContextMeta = Partial<Record<'last_bot_message' | 'last_bot_ts', string>>
type Lookup = (channel: string, before: string) => Promise<BotMessage | undefined>

export function createLastBotContext(
  history: (args: {
    channel: string
    latest: string
    limit: number
  }) => Promise<{ messages?: HistoryMessage[] }>,
  identity: () => BotIdentity,
) {
  const sent = new Map<string, BotMessage>()

  function remember(channel: string, message: BotMessage) {
    const previous = sent.get(channel)
    if (previous && Number(previous.ts) > Number(message.ts)) return
    sent.delete(channel)
    sent.set(channel, message)
    if (sent.size > MAX_CONVERSATIONS) {
      const oldest = sent.keys().next()
      if (!oldest.done) sent.delete(oldest.value)
    }
  }

  const lookup: Lookup = async (channel, before) => {
    const cached = sent.get(channel)
    if (cached) return Number(cached.ts) < Number(before) ? cached : undefined

    const { userId, botId } = identity()
    if (!userId && !botId) return
    const { messages } = await history({ channel, latest: before, limit: HISTORY_LIMIT })
    let latest: BotMessage | undefined
    for (const message of messages ?? []) {
      if (!((userId && message.user === userId) || (botId && message.bot_id === botId))) continue
      const { text, ts } = message
      if (typeof text !== 'string' || !ts || !(Number(ts) < Number(before))) continue
      if (!latest || Number(ts) > Number(latest.ts)) latest = { text, ts }
    }
    // A send may have completed while the history request was in flight.
    const posted = sent.get(channel)
    if (posted && Number(posted.ts) < Number(before)) {
      if (!latest || Number(posted.ts) >= Number(latest.ts)) return posted
    }
    return latest
  }

  return { remember, lookup }
}

type Chat = Pick<WebClient['chat'], 'postMessage' | 'update'>

/** Capture all acknowledged text sends and edits, including outbox and streaming calls. */
export function trackBotMessages(chat: Chat, remember: (channel: string, m: BotMessage) => void) {
  const postMessage = chat.postMessage.bind(chat)
  const update = chat.update.bind(chat)
  function record(
    result: {
      ok?: boolean
      channel?: string
      ts?: string
      text?: string
      message?: { text?: string }
    },
    args: { channel: string; text?: string },
  ) {
    if (result.ok && result.ts) {
      remember(result.channel ?? args.channel, {
        ts: result.ts,
        text: result.message?.text ?? result.text ?? args.text ?? '',
      })
    }
  }
  chat.postMessage = async (args) => {
    const result = await postMessage(args)
    record(result, args)
    return result
  }
  chat.update = async (args) => {
    const result = await update(args)
    record(result, args)
    return result
  }
}

async function getContext(ev: Record<string, unknown>, lookup: Lookup): Promise<ContextMeta> {
  if (
    ev.thread_ts ||
    typeof ev.channel !== 'string' ||
    !/^[A-Z0-9]{1,32}$/.test(ev.channel) ||
    typeof ev.ts !== 'string' ||
    !/^\d+\.\d+$/.test(ev.ts)
  )
    return {}
  try {
    const prior = await lookup(ev.channel, ev.ts)
    if (!prior?.text) return {}
    // Pairing codes and restart challenges are intentionally delivered out of band.
    if (
      /^(?:Your pairing code is still:|Hi! I need to verify you before connecting\.|Confirm with: `!restart )/.test(
        prior.text,
      )
    ) {
      return {}
    }
    const chars = Array.from(prior.text)
    const text =
      chars.length > MAX_CONTEXT_CHARS
        ? `${chars.slice(0, MAX_CONTEXT_CHARS).join('')}…`
        : prior.text
    return { last_bot_message: text, last_bot_ts: prior.ts }
  } catch {
    return {}
  }
}

export async function dispatchInboundWithContext(
  ev: Record<string, unknown>,
  result: GateResult,
  lookup: Lookup,
  handlers: {
    drop: () => void
    pair: () => Promise<void>
    deliver: (context: () => Promise<ContextMeta>) => Promise<void>
  },
): Promise<void> {
  switch (result.action) {
    case 'drop':
      return handlers.drop()
    case 'pair':
      return handlers.pair()
    case 'deliver':
      return handlers.deliver(() => getContext(ev, lookup))
  }
}
