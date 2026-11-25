import { afterEach, describe, expect, test } from 'bun:test'
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parsePermissionRelay } from './lib.ts'

// Each case boots the real server.ts over stdio against the real Slack SDK
// classes with the network stubbed (test-support/slack-offline.preload.ts), so
// the wiring is under test, not only the parser.

const OFF_NOTICE = '[slack] permission relay OFF'
const CHANNEL = 'C0RELAY001'
const cleanups: Array<() => Promise<void> | void> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
})

async function until<T>(
  what: string,
  read: () => T | undefined,
  detail: () => string,
  ms = 8000,
): Promise<T> {
  const deadline = Date.now() + ms
  for (;;) {
    const value = read()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}\n${detail()}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

async function boot(relay: string | undefined, stateEnvLine = '') {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'permission-relay-')))
  const stateDir = join(root, 'state')
  mkdirSync(stateDir)
  writeFileSync(
    join(stateDir, '.env'),
    `SLACK_BOT_TOKEN=xoxb-test\nSLACK_APP_TOKEN=xapp-test\n${stateEnvLine}\n`,
  )
  writeFileSync(
    join(stateDir, 'access.json'),
    JSON.stringify({
      channels: { [CHANNEL]: { requireMention: true, allowFrom: [] } },
      policy: [
        { id: 'allow-read', effect: 'auto_approve', match: { tool: 'Read' } },
        { id: 'no-bash', effect: 'deny', match: { tool: 'Bash' }, reason: 'blocked' },
      ],
    }),
  )
  const child: ChildProcessWithoutNullStreams = spawn(
    process.execPath,
    [
      '--preload',
      join(import.meta.dir, 'test-support', 'slack-offline.preload.ts'),
      join(import.meta.dir, 'server.ts'),
    ],
    {
      cwd: root,
      // Built from scratch: nothing from the developer's environment leaks in.
      env: {
        PATH: process.env.PATH ?? '',
        HOME: root,
        SLACK_STATE_DIR: stateDir,
        ...(relay === undefined ? {} : { SLACK_PERMISSION_RELAY: relay }),
      },
    },
  )
  const exited = new Promise<void>((r) => child.once('exit', () => r()))
  cleanups.push(async () => {
    child.kill('SIGKILL')
    await exited
    rmSync(root, { recursive: true, force: true })
  })

  let out = ''
  let err = ''
  child.stdout.on('data', (d) => {
    out += d
  })
  child.stderr.on('data', (d) => {
    err += d
  })
  const complete = (s: string) => s.split('\n').slice(0, -1)
  const messages = (): any[] =>
    complete(out)
      .filter(Boolean)
      .map((l) => JSON.parse(l))
  const stubs = (kind: string): any[] =>
    complete(err)
      .filter((l) => l.startsWith(`STUB ${kind} `))
      .map((l) => JSON.parse(l.slice(`STUB ${kind} `.length)))
  const send = (msg: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
  const response = (id: number) =>
    until(
      `response ${id}`,
      () => messages().find((m) => m.id === id),
      () => err,
    )

  send({
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    },
  })
  const init = await response(1)
  send({ method: 'notifications/initialized' })

  return {
    experimental: Object.keys(init.result.capabilities.experimental).sort(),
    stderr: () => err,
    clients: () => stubs('client'),
    posts: () => stubs('call').filter((c) => c.method === 'chat.postMessage'),
    verdicts: () =>
      messages()
        .filter((m) => m.method === 'notifications/claude/channel/permission')
        .map((m) => `${m.params.request_id}:${m.params.behavior}`),
    request: (request_id: string, tool_name: string) =>
      send({
        method: 'notifications/claude/channel/permission_request',
        params: { request_id, tool_name, description: 'd', input_preview: '{}' },
      }),
    ping: async (id: number) => {
      send({ id, method: 'ping' })
      await response(id)
    },
  }
}

const ON: Array<string | undefined> = [undefined, '', '   ', 'on', 'ON', ' on ']
const OFF = ['off', 'off ', 'OFF', '0', 'no', 'false', 'disabled', 'of', 'true', '1']

describe('parsePermissionRelay', () => {
  for (const raw of ON) {
    test(`${JSON.stringify(raw)} keeps the relay`, () => {
      expect(parsePermissionRelay(raw)).toBe(true)
    })
  }
  for (const raw of OFF) {
    test(`${JSON.stringify(raw)} turns the relay off`, () => {
      expect(parsePermissionRelay(raw)).toBe(false)
    })
  }
})

describe('server.ts declares the permission capability only with the relay on', () => {
  for (const raw of [undefined, '', 'on']) {
    test(`SLACK_PERMISSION_RELAY=${JSON.stringify(raw)} -> declared, no notice`, async () => {
      const s = await boot(raw)
      expect(s.experimental).toEqual(['claude/channel', 'claude/channel/permission'])
      expect(s.stderr()).not.toContain(OFF_NOTICE)
    }, 15_000)
  }
  for (const raw of ['off', 'off ', 'OFF', '0', 'no', 'false']) {
    test(`SLACK_PERMISSION_RELAY=${JSON.stringify(raw)} -> not declared, one notice`, async () => {
      const s = await boot(raw)
      expect(s.experimental).toEqual(['claude/channel'])
      expect(s.stderr().split('\n').filter((l) => l.includes(OFF_NOTICE))).toHaveLength(1)
    }, 15_000)
  }
  test('a line in the state-dir .env has no effect', async () => {
    const s = await boot(undefined, 'SLACK_PERMISSION_RELAY=off')
    expect(s.experimental).toContain('claude/channel/permission')
  }, 15_000)
})

describe('permission_request handler', () => {
  test('relay on: policy rules run and an unmatched tool is posted to Slack', async () => {
    const s = await boot(undefined)
    s.request('abcde', 'Read')
    s.request('abcdf', 'Bash')
    s.request('abcdg', 'Write')
    await until(
      'two verdicts and two posts',
      () => (s.verdicts().length >= 2 && s.posts().length >= 2 ? true : undefined),
      s.stderr,
    )
    expect(s.verdicts().sort()).toEqual(['abcde:allow', 'abcdf:deny'])
    const texts = s.posts().map((p) => p.text)
    expect(texts.some((t) => t.includes('Policy denied'))).toBe(true)
    expect(texts.some((t) => t.includes('Claude wants to run Write'))).toBe(true)
  }, 15_000)

  test('relay off: no verdict and no Slack post, even if a request arrives', async () => {
    const s = await boot('off')
    s.request('abcde', 'Read')
    s.request('abcdf', 'Bash')
    s.request('abcdg', 'Write')
    await s.ping(2)
    await new Promise((r) => setTimeout(r, 250))
    await s.ping(3)
    expect(s.verdicts()).toEqual([])
    expect(s.posts()).toEqual([])
  }, 15_000)
})

describe('Slack clients never attach the token-bearing request to errors', () => {
  test('all three bot clients and the Socket Mode inner client', async () => {
    const s = await boot(undefined)
    expect(s.clients().sort((a, b) => a.owner.localeCompare(b.owner))).toEqual([
      { owner: 'bot', attachOriginal: false },
      { owner: 'bot', attachOriginal: false },
      { owner: 'bot', attachOriginal: false },
      { owner: 'socket', attachOriginal: false },
    ])
  }, 15_000)
})
