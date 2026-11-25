// Preloaded into a spawned server.ts by permission-relay.test.ts. Keeps the real
// Slack SDK classes but never opens a connection, and reports on stderr:
//   STUB client <json>  one line per WebClient built (SocketModeClient's inner one too)
//   STUB call <json>    one line per Web API call, answered locally
import { SocketModeClient } from '@slack/socket-mode'
import { WebClient } from '@slack/web-api'

const report = (kind: string, data: unknown) =>
  process.stderr.write(`STUB ${kind} ${JSON.stringify(data)}\n`)

// The SDK constructor assigns this field, so a prototype setter sees the value
// every client ends up with, including the SDK default of true.
const FIELD = 'attachOriginalToWebAPIRequestError'
Object.defineProperty(WebClient.prototype, FIELD, {
  set(this: WebClient, value: unknown) {
    report('client', { owner: this.token ? 'bot' : 'socket', attachOriginal: value })
    Object.defineProperty(this, FIELD, { value, writable: true })
  },
})

WebClient.prototype.apiCall = async (method: string, args?: Record<string, unknown>) => {
  report('call', { method, text: args?.text })
  return { ok: true, ts: '1.000001' }
}
SocketModeClient.prototype.start = () => new Promise(() => {})
