/** Approved packaging workflows and machine publication targets. */
import { z } from 'zod'

/** Each target is produced by its own manually dispatched workflow. */
export const desktopPackageWorkflows = {
  'mac-arm64': '.github/workflows/macos-package.yml',
  'mac-x64': '.github/workflows/macos-intel-package.yml',
  'win-x64': '.github/workflows/windows-package.yml',
} as const

/**
 * Identify source refs accepted by the official and community Desktop packaging distributions.
 * @param ref Retained source ref.
 * @returns Whether a production package can come from the ref.
 */
export function isDesktopProductionSourceRef(ref: string): boolean {
  return /^(?:master|main|dsh-v[0-9][0-9A-Za-z.-]*)$/u.test(ref)
}

const targetSchema = z.enum(['mac-arm64', 'mac-x64', 'win-x64'])

/** Machine labels are unique; a scalar target is shorthand for a one-element target list. */
export const desktopPublishRunnersSchema = z.record(z.string(), z.object({
  label: z.string().regex(/^dsh-[a-z0-9-]+$/u),
  target: z.union([targetSchema, z.array(targetSchema).min(1)])
    .transform(value => typeof value === 'string' ? [value] : value),
}))
