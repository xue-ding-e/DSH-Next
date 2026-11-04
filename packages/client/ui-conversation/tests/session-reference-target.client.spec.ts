/** Captured reference identities take precedence over mutable titles and ambiguous labels. */
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { formatSessionReferenceMention } from '@deepseek-ai/dsh-session-reference/uri'
import { sessionReferenceTarget } from '../src/client/session-reference-target.ts'

describe('Session reference targets', () => {
  it('uses the exact message-associated identity or canonical URI even when labels repeat', () => {
    const target = SessionId('second')
    expect(sessionReferenceTarget('@Same title', target)).toBe(target)
    expect(sessionReferenceTarget('@Same title', SessionId('first'))).toBe('first')
    const mention = formatSessionReferenceMention({ sessionId: target, label: 'Old ] label' })
    expect(sessionReferenceTarget(mention, undefined)).toBe(target)
  })

  it('refuses bare historical labels without their own captured identity and rejects malformed URIs', () => {
    expect(() => sessionReferenceTarget('@Same title', undefined)).toThrow('exact target')
    expect(() => sessionReferenceTarget('@[bad](dsh-session:x)', undefined)).toThrow()
  })
})
