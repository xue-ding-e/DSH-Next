import { expect, it } from 'vitest'
import { desktopUpdateChannel } from '../src/update-channel.ts'

it('reads the installed channel independently from the current version', () => {
  expect(desktopUpdateChannel({ version: '1.0.0', dshDesktopUpdateChannel: 'nightly' })).toBe('nightly')
  expect(desktopUpdateChannel({ version: '1.0.0', dshDesktopUpdateChannel: 'stable' })).toBe('stable')
  expect(desktopUpdateChannel({ version: '1.0.0' })).toBe('nightly')
  expect(() => desktopUpdateChannel({ dshDesktopUpdateChannel: 'latest' })).toThrow(/channel/u)
  expect(() => desktopUpdateChannel({ dshDesktopUpdateChannel: 'beta' })).toThrow(/channel/u)
  expect(() => desktopUpdateChannel(null)).toThrow(/manifest/u)
})

it('accepts a channel named by the packaged version and rejects any other custom channel', () => {
  // A version-derived feed keeps the published channel and its prerelease field in agreement,
  // which is the only pairing electron-updater matches by equality.
  expect(desktopUpdateChannel({ version: '0.2.1-rc.3.20261031.5', dshDesktopUpdateChannel: 'rc' })).toBe('rc')
  expect(() => desktopUpdateChannel({ version: '0.2.1-rc.3.20261031.5', dshDesktopUpdateChannel: 'beta' })).toThrow(/channel/u)
  // A stable version has no prerelease field to name a feed.
  expect(() => desktopUpdateChannel({ version: '0.2.1', dshDesktopUpdateChannel: 'rc' })).toThrow(/channel/u)
  expect(() => desktopUpdateChannel({ dshDesktopUpdateChannel: 'rc' })).toThrow(/channel/u)
})

it('reads only the first prerelease field, ignoring later ones and build metadata', () => {
  expect(desktopUpdateChannel({ version: '0.2.1-rc.3.20261031.5+abc', dshDesktopUpdateChannel: 'rc' })).toBe('rc')
  // A later prerelease field cannot name the feed.
  expect(() => desktopUpdateChannel({ version: '0.2.1-rc.3', dshDesktopUpdateChannel: '3' })).toThrow(/channel/u)
  // Fixed channels stay valid regardless of the version they ship with.
  expect(desktopUpdateChannel({ version: '0.2.1-anything.1', dshDesktopUpdateChannel: 'nightly' })).toBe('nightly')
})

it('keeps Next on its packaged GitHub version channel independently of official feed names', () => {
  const next = { dshNext: {}, version: '0.2.2-rc.1.20261105.12', dshDesktopUpdateChannel: 'rc' }
  expect(desktopUpdateChannel(next)).toBe('rc')
  for (const channel of ['stable', 'nightly', 'latest']) {
    expect(() => desktopUpdateChannel({ ...next, dshDesktopUpdateChannel: channel })).toThrow(/channel/u)
  }
  expect(desktopUpdateChannel({ dshNext: {}, version: '0.2.2', dshDesktopUpdateChannel: 'latest' })).toBe('latest')
})
