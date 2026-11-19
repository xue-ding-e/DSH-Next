/**
 * Remove inherited release/signing credentials and select the standalone unsigned Next identity.
 * @param environment Build-tool environment; defaults to the process environment.
 * @returns Isolated settings for the unsigned Next package.
 */
export function nextDesktopPackageEnvironment(environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv
/**
 * Validate the explicitly selected distribution without accepting signed/official identity overrides.
 * @param environment Packaging settings.
 * @returns Whether this is a validated Next package.
 */
export function isNextDesktopPackage(environment: NodeJS.ProcessEnv): boolean
