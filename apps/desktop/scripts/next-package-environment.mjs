/** Explicit, credential-free packaging mode for the independently installed Next desktop. */
import { NEXT_DESKTOP_IDENTITY } from '../src/next-distribution.ts'

/**
 * Select an unsigned Next package without inheriting upstream release services or signing credentials.
 * @param {NodeJS.ProcessEnv} environment Build-tool environment, never changed in place.
 * @returns {NodeJS.ProcessEnv} Isolated manual-update distribution settings.
 */
export function nextDesktopPackageEnvironment(environment = process.env) {
  return {
    ...Object.fromEntries(Object.entries(environment).filter(([name]) =>
      !/KEY|SECRET|TOKEN|PASSWORD|^APPLE_|^(?:WIN_)?CSC_|^DOWNLOAD_|^DSH_DESKTOP_/iu.test(name))),
    DSH_DESKTOP_DISTRIBUTION: 'next',
    DSH_DESKTOP_APP_ID: NEXT_DESKTOP_IDENTITY.appId,
    DSH_DESKTOP_UNSIGNED: '1',
    CSC_IDENTITY_AUTO_DISCOVERY: 'false',
  }
}

/**
 * Reject accidental use of the Next manual mode as a signed or official distribution.
 * @param {NodeJS.ProcessEnv} environment Packaging settings.
 * @returns {boolean} Whether the explicitly selected and validated distribution is Next.
 */
export function isNextDesktopPackage(environment) {
  if (environment.DSH_DESKTOP_DISTRIBUTION === undefined) return false
  if (environment.DSH_DESKTOP_DISTRIBUTION !== 'next'
    || environment.DSH_DESKTOP_APP_ID !== NEXT_DESKTOP_IDENTITY.appId
    || environment.DSH_DESKTOP_UNSIGNED !== '1') {
    throw new Error('Next desktop package: only the explicit unsigned manual-update distribution is configured')
  }
  return true
}
