/** Isolated Windows Electron distribution with development-only executable branding. */
import { createHash } from 'node:crypto'
import { closeSync, cpSync, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync,
  readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { Data, NtExecutable, NtExecutableResource, Resource, version as reseditVersion } from 'resedit'

const PRODUCT_NAME = 'DeepSeek Harness (development)'
const STAMP = 'dsh-development.json'

/** Inputs for a disposable copy; directory must already exist outside the Electron distribution. */
export interface DevelopmentWindowsAppOptions {
  readonly electron: string
  readonly directory: string
  readonly icon: string
}

function fileDigest(path: string): string {
  const hash = createHash('sha256')
  const descriptor = openSync(path, 'r')
  try {
    const buffer = Buffer.alloc(1024 * 1024)
    let length: number
    while ((length = readSync(descriptor, buffer)) !== 0) hash.update(buffer.subarray(0, length))
    return hash.digest('hex')
  } finally {
    closeSync(descriptor)
  }
}

function distributionDigest(directory: string, skipStamp = false): string {
  const hash = createHash('sha256')
  function visit(path: string): void {
    for (const name of readdirSync(path).sort()) {
      const file = join(path, name)
      const local = relative(directory, file)
      if (skipStamp && local === STAMP) continue
      const stat = lstatSync(file)
      if (stat.isDirectory()) {
        hash.update(JSON.stringify([local, 'directory']))
        visit(file)
      } else if (stat.isFile()) {
        hash.update(JSON.stringify([local, fileDigest(file)]))
      } else {
        throw new Error(`desktop development: unsupported linked or special distribution file ${file}`)
      }
    }
  }
  visit(directory)
  return hash.digest('hex')
}

function contains(directory: string, path: string): boolean {
  const local = relative(directory, path)
  return local === '' || (!isAbsolute(local) && local !== '..' && !local.startsWith(`..${sep}`))
}

function assertCacheDirectory(directory: string): void {
  const stat = lstatSync(directory, { throwIfNoEntry: false })
  if (stat !== undefined && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new Error(`desktop development: cache must be an ordinary directory: ${directory}`)
  }
}

function brandedExecutable(path: string, icon: Buffer): Buffer {
  // Resource changes invalidate Authenticode; only the disposable copy is emitted unsigned.
  const executable = NtExecutable.from(readFileSync(path), { ignoreCert: true })
  const resources = NtExecutableResource.from(executable)
  const versions = Resource.VersionInfo.fromEntries(resources.entries)
  const groups = Resource.IconGroupEntry.fromEntries(resources.entries)
  const icons = Data.IconFile.from(icon).icons.map(item => item.data)
  if (versions.length === 0 || groups.length === 0 || icons.length === 0
    || versions.some(version => version.getAllLanguagesForStringValues().length === 0)) {
    throw new Error(`desktop development: Electron version/icon resources and a nonempty ICO are required: ${path}`)
  }
  for (const version of versions) {
    for (const language of version.getAllLanguagesForStringValues()) {
      version.setStringValues(language, { ProductName: PRODUCT_NAME, FileDescription: PRODUCT_NAME })
    }
    version.outputToResourceEntries(resources.entries)
  }
  for (const group of groups) {
    Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, icons)
  }
  resources.outputResource(executable)
  return Buffer.from(executable.generate())
}

/**
 * Prepare a branded Windows executable without modifying the installed Electron distribution.
 * Full content digests validate the inputs and cached distribution; unchanged copies are reused.
 * Failures stop launch, leave no valid stamp for partial copies, and require closing Desktop before replacement.
 * @param options - Installed executable, existing private development directory, and product ICO.
 * @returns Copied executable; callers must still pass the workspace app path and development settings.
 */
export function prepareDevelopmentWindowsApp(options: DevelopmentWindowsAppOptions): string {
  const electron = realpathSync(options.electron)
  const source = dirname(electron)
  const directory = realpathSync(options.directory)
  const bundle = join(directory, 'windows-app')
  if (contains(source, bundle) || contains(bundle, source)) {
    throw new Error('desktop development: Windows cache and installed Electron distribution must not overlap')
  }
  assertCacheDirectory(bundle)
  // Electron's Windows app.isPackaged depends on keeping the electron.exe basename.
  const executable = join(bundle, basename(electron))
  const stamp = join(bundle, STAMP)
  const icon = readFileSync(options.icon)
  const identity = { schemaVersion: 1, source: electron, distribution: distributionDigest(source),
    icon: createHash('sha256').update(icon).digest('hex'), productName: PRODUCT_NAME, reseditVersion }
  if (existsSync(stamp) && existsSync(executable)
    && readFileSync(stamp, 'utf8') === JSON.stringify({ ...identity, output: distributionDigest(bundle, true) })) {
    return executable
  }
  const binary = brandedExecutable(electron, icon)
  const staging = mkdtempSync(join(directory, 'windows-app-'))
  try {
    cpSync(source, staging, { recursive: true })
    const copiedElectron = join(staging, basename(electron))
    writeFileSync(copiedElectron, binary)
    writeFileSync(join(staging, STAMP), JSON.stringify({ ...identity, output: distributionDigest(staging, true) }))
    assertCacheDirectory(bundle)
    rmSync(bundle, { recursive: true, force: true })
    renameSync(staging, bundle)
  } catch (error) {
    throw new Error(`desktop development: cannot prepare Windows app at ${bundle}; close Desktop and retry`, { cause: error })
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
  return executable
}
