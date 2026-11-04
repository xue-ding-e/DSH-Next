/** Sent Session references share pointer preferences with the composer and retain local failure feedback. */
import { useRef, useState } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, Modal, ReferenceChip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { UserTextNodeProps } from '../contract/slots.ts'
import type { SessionReferenceNavigation } from '../../reference-navigation-settings.ts'
import { ReferenceGesture } from '../reference-gesture.ts'
import css from './SessionReference.module.css'

/** Scope-authorized navigation and the shared live settings source. */
export interface SessionReferenceInjected {
  hooks: { referenceNavigation: ObservableSnapshot<Readonly<SessionReferenceNavigation>> }
  /**
   * Open the exact identity associated with this message or its canonical mention.
   * @param raw - original mention spelling.
   * @param sessionId - exact message-associated identity when available.
   * @throws if the reference is ambiguous, invalid, unavailable, or navigation fails.
   */
  openSessionReference(raw: string, sessionId: SessionId | undefined): void
}

type Props = UserTextNodeProps<'session'> & InjectFace<SessionReferenceInjected> & PropsLocale<'conversation'>

/**
 * Render a keyboard-accessible Session reference with selection-safe pointer activation.
 * @param props - parsed reference, scope navigation, preference, and locale seat.
 * @returns the inline reference and a retry dialog after navigation failure.
 */
export function SessionReference({ node, raw, interactive, useReferenceNavigation, openSessionReference, t }: Props) {
  const preference = useReferenceNavigation(value => value)
  const gesture = useRef(new ReferenceGesture())
  const [failed, setFailed] = useState(false)
  const open = (): void => {
    try { openSessionReference(raw, node.data.sessionId); setFailed(false) }
    catch (_error: unknown) { setFailed(true) }
  }
  const contents = <ReferenceChip appearance="session" label={node.data.label} title={raw} />
  if (!interactive) return contents
  return <>
    <span role="link" tabIndex={0} className={css.link} data-session-reference-link
      onMouseDown={(event) => {
        const selected = event.currentTarget.ownerDocument.getSelection()?.isCollapsed === false
        if (gesture.current.begin(event, event.currentTarget, preference, selected) && event.detail === 2) event.preventDefault()
      }}
      onPointerMove={(event) => { gesture.current.move(event) }}
      onPointerLeave={() => { gesture.current.cancel() }}
      onPointerCancel={() => { gesture.current.cancel() }}
      onDragStart={() => { gesture.current.cancel() }}
      onBlur={() => { gesture.current.cancel() }}
      onClick={(event) => {
        if (event.detail === 0) { open(); return }
        const selected = event.currentTarget.ownerDocument.getSelection()?.isCollapsed === false
        if (gesture.current.finish(event, event.currentTarget, preference, selected)) open()
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' || event.repeat) return
        event.preventDefault()
        open()
      }}
    >{contents}</span>
    {failed && <Modal open onClose={() => { setFailed(false) }} closeLabel={t('reference.open.close')}
      title={t('reference.open.title')} description={t('reference.open.failed')}
      footer={<><Button variant="outline" onClick={() => { setFailed(false) }}>{t('reference.open.close')}</Button>
        <Button variant="primary" onClick={open}>{t('reference.open.retry')}</Button></>}
    />}
  </>
}
