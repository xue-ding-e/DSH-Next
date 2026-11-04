/** Canonical URI bytes are shared by Node hosts and browser drag sources. */
import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionReferenceError } from '../src/config.ts'
import { decodeSessionReferenceUri, encodeSessionReferenceUri, formatSessionReferenceMention, parseSessionReferenceText } from '../src/uri.ts'

describe('browser-safe session reference URI', () => {
  it.each(['', 'session-1', '雪/🧭/"/\\/\n', '\uD800', '\uDC00', '\uFEFFid', 'a'.repeat(65536)])(
    'preserves the existing JSON UTF-8 base64url protocol for %j', (value) => {
      const id = brandString<SessionId>(value)
      const expected = `dsh-session:${Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')}`
      expect(encodeSessionReferenceUri(id)).toBe(expected)
      expect(decodeSessionReferenceUri(expected)).toBe(id)
    },
  )

  it('formats escaped labels and round-trips references without a Node Buffer global', () => {
    const buffer = Object.getOwnPropertyDescriptor(globalThis, 'Buffer')!
    const id = brandString<SessionId>('雪/🧭/"/\\/\n')
    const expected = encodeSessionReferenceUri(id)
    let actual: ReturnType<typeof parseSessionReferenceText>
    let mention: string
    Object.defineProperty(globalThis, 'Buffer', { configurable: true, value: undefined })
    try {
      if (encodeSessionReferenceUri(id) !== expected || decodeSessionReferenceUri(expected) !== id) {
        throw new Error('browser URI differs from the canonical host value')
      }
      mention = formatSessionReferenceMention({ sessionId: id, label: '源]\\会话' })
      actual = parseSessionReferenceText(mention)
    } finally {
      Object.defineProperty(globalThis, 'Buffer', buffer)
    }
    expect(mention).toBe(`@[源\\]\\\\会话](${expected})`)
    expect(actual).toEqual({ text: '@源]\\会话', references: [{ sessionId: id, label: '源]\\会话' }] })
  })

  it.each([
    'https://example.test', 'dsh-session:', 'dsh-session:%%%', 'dsh-session:A',
    'dsh-session:IiJ', 'dsh-session:InNlc3Npb24i=', 'dsh-session:e30', 'dsh-session:Iv8i',
    'dsh-session:77u_Ingi',
  ])('rejects malformed or noncanonical input %s with the existing failure code', (uri) => {
    expect(() => decodeSessionReferenceUri(uri)).toThrow(SessionReferenceError)
    expect(() => decodeSessionReferenceUri(uri)).toThrow(expect.objectContaining({ code: 'SESSION_REFERENCE_INVALID_REFERENCE' }))
  })
})
