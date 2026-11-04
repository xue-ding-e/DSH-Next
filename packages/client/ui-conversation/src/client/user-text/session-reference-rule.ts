/** Original-text Session candidates with explicit wire spelling and longest known labels. */
import type { UserTextRule, UserTextNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { parseSessionReferenceText } from '@deepseek-ai/dsh-session-reference/uri'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    session: { readonly label: string; readonly sessionId?: SessionId }
  }
  interface UserTextFacts {
    sessionLabels: readonly string[]
    /** Exact identities associated with this message's recall, independent of current titles. */
    sessionReferences: readonly { readonly sessionId: SessionId; readonly label: string }[]
  }
}

/** Find the nearest Session reference; bare labels read their Facts only at a non-wire @ position. */
export const sessionReferenceRule: UserTextRule<'session'> = {
  id: 'session',
  order: 10,
  match(text, from, context) {
    let labels: readonly string[] | undefined
    let readLabels = false
    const wire = /@\[((?:\\.|[^\\\]\n])*)\]\(dsh-session:[^)\s]+\)/uy
    for (let start = text.indexOf('@', from); start >= 0; start = text.indexOf('@', start + 1)) {
      wire.lastIndex = start
      const explicit = wire.exec(text)
      if (explicit !== null) {
        try {
          const reference = parseSessionReferenceText(explicit[0]).references[0]
          if (reference !== undefined) return {
            id: 'session', start, end: start + explicit[0].length,
            data: { label: reference.label ?? reference.sessionId, sessionId: reference.sessionId },
          }
        } catch (_error: unknown) {
          // Historical display does not require a decodable URI; activation still refuses an invalid identity.
          return {
            id: 'session', start, end: start + explicit[0].length,
            data: { label: (explicit[1] as string).replace(/\\(.)/gu, '$1') },
          }
        }
      }
      if (!readLabels) {
        const references = context.read('sessionReferences')
        labels = references?.map(reference => reference.label) ?? context.read('sessionLabels')
        readLabels = true
      }
      let best: UserTextNode<'session'> | undefined
      for (const label of labels ?? []) {
        if (label.length === 0 || !text.startsWith(label, start + 1)) continue
        const end = start + label.length + 1
        if (best === undefined || end > best.end) best = { id: 'session', start, end, data: { label } }
      }
      if (best !== undefined) {
        const matches = context.read('sessionReferences')?.filter(reference => reference.label === best.data.label)
        const target = matches?.[0]
        if (target !== undefined && matches?.every(reference => reference.sessionId === target.sessionId)) {
          return { ...best, data: { ...best.data, sessionId: target.sessionId } }
        }
        return best
      }
    }
    return undefined
  },
}
