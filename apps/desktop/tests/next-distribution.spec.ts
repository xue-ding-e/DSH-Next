/** Pure packaging inputs and identity must work before workspace runtime libraries are built. */
import { describe, expect, it } from 'vitest'
import { NEXT_DESKTOP_IDENTITY, nextDesktopDistribution } from '../src/next-distribution.ts'
import { nextDesktopPackageEnvironment } from '../scripts/next-package-environment.mjs'
import { createElectronBuilderConfig } from '../scripts/electron-builder-config.mjs'

const manifest = () => ({ name: NEXT_DESKTOP_IDENTITY.packageName, productName: NEXT_DESKTOP_IDENTITY.productName,
  dshDesktopAppId: NEXT_DESKTOP_IDENTITY.appId, dshDesktopUpdateChannel: 'nightly',
  dshNext: { schemaVersion: 1, repository: NEXT_DESKTOP_IDENTITY.repository,
    repositoryId: NEXT_DESKTOP_IDENTITY.repositoryId, updateMode: 'manual' } })

describe('Next package identity', () => {
  it('leaves wholly unmarked official packages unchanged, but refuses partially marked Next packages', () => {
    expect(nextDesktopDistribution({ name: '@deepseek-ai/dsh-desktop', productName: 'DeepSeek Harness' })).toBeUndefined()
    expect(nextDesktopDistribution(manifest())).toEqual({ channel: 'nightly', updateMode: 'manual' })
    for (const value of [
      { name: NEXT_DESKTOP_IDENTITY.packageName }, { dshDesktopAppId: NEXT_DESKTOP_IDENTITY.appId },
      { ...manifest(), dshNext: undefined }, { ...manifest(), productName: 'DeepSeek Harness' },
    ]) expect(() => nextDesktopDistribution(value)).toThrow(/identity/u)
  })

  it.each([['win32', 'x64'], ['darwin', 'arm64'], ['darwin', 'x64']] as const)(
    'builds an independent unsigned %s %s distribution without enabling an upstream feed', (platform, arch) => {
      const environment = nextDesktopPackageEnvironment({ DSH_DESKTOP_APP_ID: 'com.deepseek.harness',
        DOWNLOAD_TEST_ORIGIN: 'https://upstream.invalid', GH_TOKEN: 'synthetic-not-a-credential' })
      const config = createElectronBuilderConfig(environment, platform, arch)
      expect(config.appId).toBe(NEXT_DESKTOP_IDENTITY.appId)
      expect(config.productName).toBe(NEXT_DESKTOP_IDENTITY.productName)
      expect(config.nsis.guid).toBe(NEXT_DESKTOP_IDENTITY.installerGuid)
      expect(config.protocols[0].schemes).toEqual(['dsh-next'])
      expect(config.artifactName).toBe('dsh-next-${version}-${os}-${arch}-unsigned.${ext}')
      expect(config.publish).toBeNull()
      expect(config.files).toContain('lib/next-cli-entry.js')
      expect(config.extraMetadata).toMatchObject(manifest())
      expect(nextDesktopDistribution(config.extraMetadata)).toEqual({ channel: 'nightly', updateMode: 'manual' })
      expect(environment.GH_TOKEN).toBeUndefined()
    },
  )
})
