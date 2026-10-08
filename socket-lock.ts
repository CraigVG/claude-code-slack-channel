/**
 * socket-lock.ts — one Socket Mode connection per Slack app token per host.
 *
 * Slack delivers each Socket Mode event to ONE of the app's open connections.
 * A second process started with the same state dir (a `claude -p` run in the
 * same project, a tmux-pane teammate, a forgotten session) silently takes a
 * share of the inbound events, and the main session never sees them
 * (2026-10-08: a teammate pane with the default state dir split a session's
 * events in #drillerdb-hive). The first process to start holds `socket.lock`
 * in its state dir; later processes keep their outbound tools but do not open
 * Socket Mode, and retry so one of them takes over when the holder exits.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'

export type SocketLockResult = { acquired: true } | { acquired: false; holder: number }

function readHolder(path: string): number {
  try {
    return Number.parseInt(readFileSync(path, 'utf-8').trim(), 10)
  } catch {
    return Number.NaN
  }
}

/** Try to take the lock for `pid`. `isAlive(holder)` must say whether the
 *  recorded holder is still a live server process (PID plus command check,
 *  so a stale file from before a reboot never blocks). A dead, unreadable or
 *  garbage holder is replaced. */
export function tryAcquireSocketLock(
  path: string,
  pid: number,
  isAlive: (holder: number) => boolean,
): SocketLockResult {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, `${pid}\n`, { flag: 'wx', mode: 0o600 })
      return { acquired: true }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    const holder = readHolder(path)
    if (holder === pid) return { acquired: true }
    if (Number.isInteger(holder) && holder > 0 && isAlive(holder)) return { acquired: false, holder }
    try {
      unlinkSync(path)
    } catch {
      /* another process replaced it first; the next wx attempt decides */
    }
  }
  const holder = readHolder(path)
  return { acquired: false, holder: Number.isInteger(holder) ? holder : -1 }
}

/** Remove the lock only when `pid` holds it. */
export function releaseSocketLock(path: string, pid: number): void {
  if (readHolder(path) !== pid) return
  try {
    unlinkSync(path)
  } catch {
    /* already gone */
  }
}
