import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DurableUnavailableError,
  deliverChunkedReplyDurably,
  deliverReplyDurably,
  type ReplyPoster,
} from './slack-delivery.ts'
import { createSessionSupervisor } from './supervisor.ts'

// A reply that arrives more than the lease TTL after the session's lease was
// last renewed hit "SessionHandle.update: write fenced — lease heartbeat lapsed;
// handle quarantined" on the pre-send obligation record, and the reply tool
// failed with nothing posted. The fenced write persists nothing and runs before
// any send, so it must surface as DurableUnavailableError: the caller then makes
// its single best-effort direct send in the same tool call.

describe('durable reply after a lapsed lease heartbeat', () => {
  let rawRoot: string
  let tmpRoot: string
  let nowValue: number
  const key = { channel: 'C_LAPSE', thread: 'T1' }

  beforeEach(() => {
    rawRoot = mkdtempSync(join(tmpdir(), 'supervisor-lapse-'))
    tmpRoot = realpathSync.native(rawRoot)
    nowValue = 1_700_000_000_000
  })
  afterEach(() => {
    rmSync(rawRoot, { recursive: true, force: true })
  })

  function makeSupervisor() {
    return createSessionSupervisor({
      stateRoot: tmpRoot,
      log: () => {},
      clock: () => nowValue,
      leaseTtlMs: 1000,
      ownerId: 'OWNER-1',
    })
  }

  function countingPoster() {
    const calls: string[] = []
    const poster: ReplyPoster = async (obligation) => {
      calls.push(obligation.id)
      return 'ts-1'
    }
    return { poster, calls }
  }

  test('single message: lapsed lease -> DurableUnavailableError, nothing posted', async () => {
    const sup = makeSupervisor()
    await sup.activate(key, 'U') // cached live handle with a fresh lease
    nowValue += 5_000 // past the 1s TTL, nothing renewed it
    const { poster, calls } = countingPoster()

    const err = await deliverReplyDurably(
      { supervisor: sup, post: poster },
      { id: 'r-1', channel: key.channel, thread: key.thread, text: 'hello' },
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(DurableUnavailableError)
    expect(String((err as Error).message)).toContain('lease heartbeat lapsed')
    expect(calls).toEqual([])
    expect(await sup.pendingDeliveries()).toHaveLength(0)
  })

  test('chunked: lapsed lease -> DurableUnavailableError, nothing posted', async () => {
    const sup = makeSupervisor()
    await sup.activate(key, 'U')
    nowValue += 5_000
    const { poster, calls } = countingPoster()

    const err = await deliverChunkedReplyDurably(
      { supervisor: sup, post: poster },
      { id: 'r-2', channel: key.channel, thread: key.thread, chunks: ['a', 'b'] },
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(DurableUnavailableError)
    expect(calls).toEqual([])
  })

  test('a fresh lease still delivers durably', async () => {
    const sup = makeSupervisor()
    await sup.activate(key, 'U')
    const { poster, calls } = countingPoster()

    const result = await deliverReplyDurably(
      { supervisor: sup, post: poster },
      { id: 'r-3', channel: key.channel, thread: key.thread, text: 'hello' },
    )

    expect(result).toEqual({ status: 'delivered', ts: 'ts-1' })
    expect(calls).toEqual(['r-3'])
  })
})
