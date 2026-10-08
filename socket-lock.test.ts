import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { releaseSocketLock, tryAcquireSocketLock } from './socket-lock.ts'

describe('socket-lock', () => {
  let dir = ''
  let lock = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'socklock-'))
    lock = join(dir, 'socket.lock')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  test('first process acquires and records its pid', () => {
    expect(tryAcquireSocketLock(lock, 100, () => true)).toEqual({ acquired: true })
    expect(readFileSync(lock, 'utf-8').trim()).toBe('100')
  })

  test('a second process is refused while the holder is alive', () => {
    tryAcquireSocketLock(lock, 100, () => true)
    expect(tryAcquireSocketLock(lock, 200, () => true)).toEqual({ acquired: false, holder: 100 })
    expect(readFileSync(lock, 'utf-8').trim()).toBe('100')
  })

  test('the holder re-acquiring its own lock succeeds', () => {
    tryAcquireSocketLock(lock, 100, () => true)
    expect(tryAcquireSocketLock(lock, 100, () => true)).toEqual({ acquired: true })
  })

  test('a dead holder is replaced', () => {
    tryAcquireSocketLock(lock, 100, () => true)
    expect(tryAcquireSocketLock(lock, 200, (p) => p !== 100)).toEqual({ acquired: true })
    expect(readFileSync(lock, 'utf-8').trim()).toBe('200')
  })

  test('a garbage lock file is replaced', () => {
    writeFileSync(lock, 'not-a-pid\n')
    expect(tryAcquireSocketLock(lock, 200, () => true)).toEqual({ acquired: true })
  })

  test('release removes the lock only for its holder', () => {
    tryAcquireSocketLock(lock, 100, () => true)
    releaseSocketLock(lock, 200)
    expect(existsSync(lock)).toBe(true)
    releaseSocketLock(lock, 100)
    expect(existsSync(lock)).toBe(false)
  })

  test('after the holder releases, the waiting process acquires', () => {
    tryAcquireSocketLock(lock, 100, () => true)
    expect(tryAcquireSocketLock(lock, 200, () => true).acquired).toBe(false)
    releaseSocketLock(lock, 100)
    expect(tryAcquireSocketLock(lock, 200, () => true)).toEqual({ acquired: true })
  })
})
