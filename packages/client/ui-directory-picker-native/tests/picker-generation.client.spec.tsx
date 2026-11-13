// @vitest-environment jsdom
/** A native chooser result belongs to the open request that started it. */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeDirectoryFlow } from '../src/client/flow.ts'

afterEach(cleanup)

it('never applies an old chooser response to a newer open request', async () => {
  const first = Promise.withResolvers<string | null>()
  const second = Promise.withResolvers<string | null>()
  const pick = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
  const onPicked = vi.fn(), onCancel = vi.fn(), onError = vi.fn()
  const props = { busy: false, pick, onPicked, onCancel, onError }
  const view = render(<NativeDirectoryFlow {...props} open />)
  try {
    view.rerender(<NativeDirectoryFlow {...props} open={false} />)
    view.rerender(<NativeDirectoryFlow {...props} open />)
    await act(async () => { first.resolve('/fixture/old'); await first.promise })
    expect(onPicked).not.toHaveBeenCalled()
    await act(async () => { second.resolve('/fixture/current'); await second.promise })
    expect(onPicked).toHaveBeenCalledExactlyOnceWith('/fixture/current')
  } finally { first.resolve(null); second.resolve(null); view.unmount() }
})
