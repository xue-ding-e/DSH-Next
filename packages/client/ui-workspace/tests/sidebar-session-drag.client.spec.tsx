// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import { isSidebarSessionDrag, sidebarSessionDrop } from '../src/client/SidebarSessionRows.tsx'
import { SESSION_REFERENCE_DRAG_TYPE } from '../src/client/session-drag.ts'

afterEach(cleanup)
const id = 'known-session' as SessionId
const list: SessionListState = {
  ids: [id], phase: 'ready', projectionsBySession: {},
  byId: { [id]: { id, displayTitle: 'Known', updatedAt: 1, running: false, blank: false, retainedBy: {} } },
}

function drop(type: string, payload: string) {
  let accepted = false
  let result: ReturnType<typeof sidebarSessionDrop>
  const view = render(<div data-testid="target"
    onDragOver={(event) => { accepted = isSidebarSessionDrag(event) }}
    onDrop={(event) => { result = sidebarSessionDrop(event, list) }} />)
  const dataTransfer = { types: [type], getData: (requested: string) => requested === type ? payload : '' }
  fireEvent.dragOver(view.getByTestId('target'), { dataTransfer })
  fireEvent.drop(view.getByTestId('target'), { dataTransfer })
  return { accepted, result: result! }
}

describe('sidebar conversation drops', () => {
  it('accepts the canonical reference format issued by Workspace tree rows', () => {
    expect(drop(SESSION_REFERENCE_DRAG_TYPE, JSON.stringify({ sessionId: id, label: 'Known' })))
      .toEqual({ accepted: true, result: { sessionId: id, source: 'workspace' } })
  })

  it('preserves the custom section source when a shortcut moves', () => {
    expect(drop('application/x-dsh-sidebar-session', JSON.stringify({ sessionId: id, source: 'section-one' })))
      .toEqual({ accepted: true, result: { sessionId: id, source: 'section-one' } })
  })

  it.each(['not-json', '{"sessionId":"missing-session"}', '{"sessionId":7}'])(
    'does not assign a malformed or unavailable conversation: %s', (payload) => {
      expect(drop(SESSION_REFERENCE_DRAG_TYPE, payload).result).toBeUndefined()
    },
  )

  it('keeps ordinary text drops outside sidebar organization', () => {
    expect(drop('text/plain', id)).toEqual({ accepted: false, result: undefined })
  })
})
