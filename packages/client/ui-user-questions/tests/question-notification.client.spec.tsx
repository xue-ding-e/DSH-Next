// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { QuestionNotification, type QuestionNotificationProps } from '../src/client/QuestionNotification.tsx'
import { QuestionNotificationSetting, type QuestionNotificationSettingProps } from '../src/client/QuestionNotificationSetting.tsx'
import { de, en, es, fr, ja, pt, ru, zh } from '../src/client/locales.ts'

afterEach(cleanup)

it.each([en, zh, ja, es, fr, de, ru, pt])('renders native delivery failures in the selected locale', (dictionary) => {
  const props = {
    useNotificationError: (select: (value: { kind: 'native'; seq: number }) => unknown) => select({ kind: 'native', seq: 1 }),
    dismissError: vi.fn(),
    t: (key: keyof typeof en) => dictionary[key],
  } as QuestionNotificationProps
  render(<QuestionNotification {...props} />)
  expect(screen.getByRole('alert').textContent).toBe(dictionary['notification.failed'])
})

it('renders no reminder or action controls when native delivery has not failed', () => {
  const props = {
    useNotificationError: (select: (value: null) => unknown) => select(null),
    dismissError: vi.fn(),
    t: (key: keyof typeof en) => en[key],
  } as QuestionNotificationProps
  const { container } = render(<QuestionNotification {...props} />)
  expect(container.innerHTML).toBe('')
})

it('keeps the disabled preference visible and explains an unsaved write', () => {
  const setEnabled = vi.fn()
  const props = {
    useEnabled: (select: (value: boolean) => unknown) => select(false),
    usePreferenceError: (select: (value: boolean) => unknown) => select(true),
    setEnabled, t: (key: keyof typeof en) => en[key],
  } as QuestionNotificationSettingProps
  render(<QuestionNotificationSetting {...props} />)
  expect(screen.getByRole('alert').textContent).toBe(en['settings.notifications.unsaved'])
  const toggle = screen.getByRole('switch', { name: en['settings.notifications.title'] })
  expect(toggle.getAttribute('aria-checked')).toBe('false')
  fireEvent.click(toggle)
  expect(setEnabled).toHaveBeenCalledExactlyOnceWith(true)
})
