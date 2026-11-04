/** PE branding and copy reuse use real resources without launching Electron or touching user state. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync,
  symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Data, NtExecutable, NtExecutableResource, Resource } from 'resedit'
import { expect, it, onTestFinished } from 'vitest'
import { prepareDevelopmentWindowsApp } from '../scripts/development-windows-app.ts'

const productName = 'DeepSeek Harness (development)'
const productIcon = readFileSync(resolve(import.meta.dirname, '../resources/tray-windows.ico'))

function electronFixture(productVersion = '44.7.0'): Buffer {
  const executable = NtExecutable.createEmpty(false, false)
  const resources = NtExecutableResource.from(executable)
  const strings = [1033, 2052].map(lang => ({ lang, codepage: 1200, values: {
    ProductName: 'Electron', FileDescription: 'Electron', ProductVersion: productVersion,
  } }))
  Resource.VersionInfo.create({ lang: 1033, fixedInfo: { productVersionMS: 44 << 16 }, strings })
    .outputToResourceEntries(resources.entries)
  for (const id of [101, 102]) {
    Resource.IconGroupEntry.replaceIconsForResource(resources.entries, id, 1033,
      Data.IconFile.from(productIcon).icons.slice(0, 1).map(item => item.data))
  }
  resources.outputResource(executable)
  executable.setExtraData(Buffer.from('preserved Electron overlay'))
  return Buffer.from(executable.generate())
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-windows-app-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const source = join(root, 'installed Electron 中文')
  const directory = join(root, 'private development')
  mkdirSync(join(source, 'resources'), { recursive: true })
  mkdirSync(directory)
  const electron = join(source, 'electron.exe')
  const icon = join(root, 'product.ico')
  writeFileSync(electron, electronFixture())
  writeFileSync(join(source, 'resources', 'default_app.asar'), 'original')
  writeFileSync(icon, productIcon)
  return { root, source, electron, directory, icon }
}

function resourcesAt(path: string) {
  return NtExecutableResource.from(NtExecutable.from(readFileSync(path)))
}

function iconBytes(resources: NtExecutableResource) {
  return Resource.IconGroupEntry.fromEntries(resources.entries).map(group =>
    group.getIconItemsFromEntries(resources.entries).map(item =>
      Buffer.from(item.isRaw() ? item.bin : item.generate())))
}

it('brands every version translation and icon group while preserving the installed distribution', () => {
  const options = fixture()
  const original = readFileSync(options.electron)
  const executable = prepareDevelopmentWindowsApp(options)
  expect(executable).toBe(join(options.directory, 'windows-app', 'electron.exe'))
  expect(readFileSync(options.electron)).toEqual(original)
  expect(readFileSync(join(options.source, 'resources', 'default_app.asar'), 'utf8')).toBe('original')
  expect(readFileSync(join(dirname(executable), 'resources', 'default_app.asar'), 'utf8')).toBe('original')
  const resources = resourcesAt(executable)
  const version = Resource.VersionInfo.fromEntries(resources.entries)[0]!
  expect(version.fixedInfo.productVersionMS).toBe(44 << 16)
  for (const lang of [1033, 2052]) {
    expect(version.getStringValues({ lang, codepage: 1200 })).toMatchObject({
      ProductName: productName, FileDescription: productName, ProductVersion: '44.7.0',
    })
  }
  const expectedIcons = Data.IconFile.from(productIcon).icons.map((item) => {
    if (!item.data.isRaw()) throw new Error('product ICO fixture requires PNG images')
    return Buffer.from(item.data.bin)
  })
  expect(iconBytes(resources)).toEqual([expectedIcons, expectedIcons])
  expect(Buffer.from(NtExecutable.from(readFileSync(executable)).getExtraData()!))
    .toEqual(Buffer.from('preserved Electron overlay'))
})

it('reuses an unchanged copy without rewriting the executable or completion stamp', () => {
  const options = fixture()
  const executable = prepareDevelopmentWindowsApp(options)
  const stamp = join(dirname(executable), 'dsh-development.json')
  for (const path of [executable, stamp]) utimesSync(path, 946684800, 946684800)
  const before = [statSync(executable).mtimeMs, statSync(stamp).mtimeMs]
  expect(prepareDevelopmentWindowsApp(options)).toBe(executable)
  expect([statSync(executable).mtimeMs, statSync(stamp).mtimeMs]).toEqual(before)
  expect(readdirSync(options.directory)).toEqual(['windows-app'])
})

it('refreshes changed Electron bytes even when file size and timestamp are retained', () => {
  const options = fixture()
  const executable = prepareDevelopmentWindowsApp(options)
  const before = statSync(options.electron)
  const updated = electronFixture('44.7.1')
  expect(updated.byteLength).toBe(before.size)
  writeFileSync(options.electron, updated)
  utimesSync(options.electron, before.atime, before.mtime)
  prepareDevelopmentWindowsApp(options)
  const version = Resource.VersionInfo.fromEntries(resourcesAt(executable).entries)[0]!
  expect(version.getStringValues({ lang: 1033, codepage: 1200 }).ProductVersion).toBe('44.7.1')
  expect(readFileSync(options.electron)).toEqual(updated)
})

it('refreshes companion files and removes obsolete files from only the disposable copy', () => {
  const options = fixture()
  const executable = prepareDevelopmentWindowsApp(options)
  const resource = join(options.source, 'resources', 'default_app.asar')
  const before = statSync(resource)
  writeFileSync(resource, 'updated!')
  utimesSync(resource, before.atime, before.mtime)
  const unrelated = join(options.directory, 'home', 'session.jsonl')
  mkdirSync(dirname(unrelated))
  writeFileSync(unrelated, 'private development session')
  const obsolete = join(dirname(executable), 'obsolete.dll')
  writeFileSync(obsolete, 'obsolete')
  prepareDevelopmentWindowsApp(options)
  expect(readFileSync(join(dirname(executable), 'resources', 'default_app.asar'), 'utf8')).toBe('updated!')
  expect(existsSync(obsolete)).toBe(false)
  expect(readFileSync(unrelated, 'utf8')).toBe('private development session')
})

it('refreshes the embedded icon when ICO bytes change at the same size and timestamp', () => {
  const options = fixture()
  const executable = prepareDevelopmentWindowsApp(options)
  const before = statSync(options.icon)
  const icon = Data.IconFile.from(productIcon)
  icon.icons.reverse()
  const changed = Buffer.from(icon.generate())
  expect(changed.byteLength).toBe(productIcon.byteLength)
  writeFileSync(options.icon, changed)
  utimesSync(options.icon, before.atime, before.mtime)
  prepareDevelopmentWindowsApp(options)
  const expected = Data.IconFile.from(changed).icons.map((item) => {
    if (!item.data.isRaw()) throw new Error('product ICO fixture requires PNG images')
    return Buffer.from(item.data.bin)
  })
  expect(iconBytes(resourcesAt(executable))).toEqual([expected, expected])
})

it.each(['stamp', 'executable', 'companion'] as const)('repairs a damaged cached %s', (kind) => {
  const options = fixture()
  const executable = prepareDevelopmentWindowsApp(options)
  const files = { stamp: join(dirname(executable), 'dsh-development.json'), executable,
    companion: join(dirname(executable), 'resources', 'default_app.asar') }
  const file = files[kind]
  const before = readFileSync(file)
  writeFileSync(file, 'damaged')
  prepareDevelopmentWindowsApp(options)
  expect(readFileSync(file)).toEqual(before)
})

it.each(['version', 'icon', 'translations', 'ico'] as const)(
  'leaves the last completed copy untouched when replacement %s resources are invalid', (kind) => {
    const options = fixture()
    const executable = prepareDevelopmentWindowsApp(options)
    const before = readFileSync(executable)
    const replacement = NtExecutable.from(electronFixture())
    const resources = NtExecutableResource.from(replacement)
    if (kind === 'version' || kind === 'icon') {
      resources.entries = resources.entries.filter(entry => entry.type !== (kind === 'version' ? 16 : 14))
    } else if (kind === 'translations') {
      Resource.VersionInfo.create({ lang: 1033, fixedInfo: {}, strings: [] }).outputToResourceEntries(resources.entries)
    } else {
      writeFileSync(options.icon, Buffer.from(new Data.IconFile().generate()))
    }
    resources.outputResource(replacement)
    writeFileSync(options.electron, Buffer.from(replacement.generate()))
    expect(() => prepareDevelopmentWindowsApp(options)).toThrow('version/icon resources')
    expect(readFileSync(executable)).toEqual(before)
    expect(readdirSync(options.directory)).toEqual(['windows-app'])
  },
)

it('rejects an output overlapping the installed distribution before replacing any files', () => {
  const options = fixture()
  const before = readFileSync(options.electron)
  expect(() => prepareDevelopmentWindowsApp({ ...options, directory: options.source })).toThrow('must not overlap')
  expect(readFileSync(options.electron)).toEqual(before)
})

it('rejects a junction or symlink used as the cache directory', () => {
  const options = fixture()
  const before = readFileSync(options.electron)
  symlinkSync(options.source, join(options.directory, 'windows-app'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => prepareDevelopmentWindowsApp(options)).toThrow('ordinary directory')
  expect(readFileSync(options.electron)).toEqual(before)
})
