import { describe, expect, it } from 'vitest'
import type { AssistantMessage } from '@earendil-works/pi-ai'
import { mapStopReason } from '../src/stream.ts'

describe('leading HTTP status and request body limits', () => {
  it.each([
    ['500 {"upstream":{"status":413,"message":"payload too large"}}', 'SERVER'],
    ['502 {"upstream":{"status":401,"message":"request body too large"}}', 'SERVER'],
    ['404 {"upstream":{"status":413,"message":"payload too large"}}', 'PI_AI_ERROR'],
    ['401 {"upstream":{"status":413,"message":"payload too large"}}', 'AUTH'],
    ['413 Payload Too Large', 'REQUEST_TOO_LARGE'],
    ['413', 'REQUEST_TOO_LARGE'],
    ['400 request body size exceeds maximum allowed 52428800 bytes', 'REQUEST_TOO_LARGE'],
    ['HTTP 413: Payload Too Large', 'REQUEST_TOO_LARGE'],
    ['failed to buffer the request body: length limit exceeded', 'REQUEST_TOO_LARGE'],
  ])('classifies %s without confusing the gateway and its body', (errorMessage, code) => {
    const message: AssistantMessage = {
      role: 'assistant', content: [], api: 'openai-completions', provider: 'deepseek',
      model: 'deepseek-v4-flash', timestamp: 0, stopReason: 'error', errorMessage,
      usage: {
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    }
    expect(mapStopReason(message)).toEqual({ kind: 'error', failure: { message: errorMessage, code } })
  })
})
