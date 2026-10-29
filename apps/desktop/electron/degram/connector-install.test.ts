import { promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  connectorConfirmation,
  createConnectorInstaller,
  ensureRoutesLoopback,
  isInstallableConnector,
  REVIT_COPY_ENTRIES,
  utcStamp
} from './connector-install'

const logger = { info: (): void => undefined, warn: (): void => undefined, error: (): void => undefined }
const NOW = new Date('2026-10-27T20:15:03.120Z')

let root: string
let paths: { resourcesPath: string; appData: string; localAppData: string; programData: string }

async function write(file: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  await fsp.writeFile(file, text)
}

async function bundleRevit(): Promise<void> {
  const source = path.join(paths.resourcesPath, 'revit-mcp')

  for (const entry of REVIT_COPY_ENTRIES) {
    if (entry === 'dg_revit_mcp' || entry === 'lib' || entry === 'DG.tab') {
      await write(path.join(source, entry, '__init__.py'), `# ${entry}`)
    } else {
      await write(path.join(source, entry), `${entry} v2`)
    }
  }

  await write(path.join(source, 'DG.tab', 'Connector.panel', 'Login.pushbutton', 'script.py'), 'login')
  await write(path.join(source, 'lib', '__pycache__', 'x.cpython-311.pyc'), 'bytecode')
  await write(path.join(source, 'main.py'), 'mcp server')
  await write(path.join(source, 'tests', 'test_x.py'), 'test')
}

async function bundleGrasshopper(): Promise<void> {
  const source = path.join(paths.resourcesPath, 'dg-grasshopper')
  await write(path.join(source, 'DG.gha'), 'gha v2')
  await write(path.join(source, 'DG.Core.dll'), 'core v2')
  await write(path.join(source, 'DG.Core.pdb'), 'symbols')
}

const pyRevit = (): Promise<void> => write(path.join(paths.appData, 'pyRevit', 'pyRevit_config.ini'), '[core]')
const revitTarget = (): string => path.join(paths.appData, 'pyRevit', 'Extensions', 'dg-revit-connector.extension')
const ghTarget = (): string => path.join(paths.appData, 'Grasshopper', 'Libraries', 'DG')
const installer = () => createConnectorInstaller({ paths, logger, now: () => NOW })

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'degram-connector-'))
  paths = {
    resourcesPath: path.join(root, 'resources'),
    appData: path.join(root, 'Roaming'),
    localAppData: path.join(root, 'Local'),
    programData: path.join(root, 'ProgramData')
  }
})

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true })
})

describe('connector install status', () => {
  it('reports unavailable when the build carries no package', async () => {
    await pyRevit()
    expect(await installer().statusAll()).toEqual({ revit: 'unavailable', grasshopper: 'unavailable' })
  })

  it('reports unavailable for the old read-only adapter without DG.tab', async () => {
    await bundleRevit()
    await pyRevit()
    await fsp.rm(path.join(paths.resourcesPath, 'revit-mcp', 'DG.tab'), { recursive: true })
    expect(await installer().status('revit')).toBe('unavailable')
  })

  it('needs pyRevit before the Revit connector can install', async () => {
    await bundleRevit()
    expect(await installer().status('revit')).toBe('needs-host')
    await write(path.join(paths.programData, 'pyRevit-Master', 'pyRevitfile'), '')
    expect(await installer().status('revit')).toBe('install')
  })

  it('is ready only when every bundled file matches', async () => {
    await bundleGrasshopper()
    const subject = installer()
    expect(await subject.status('grasshopper')).toBe('install')
    expect(await subject.install('grasshopper')).toBe('ready')
    await fsp.writeFile(path.join(ghTarget(), 'DG.gha'), 'gha v1')
    expect(await subject.status('grasshopper')).toBe('install')
  })
})

describe('connector install', () => {
  it('copies the pyRevit copy set only and backs up the earlier installation', async () => {
    await bundleRevit()
    await pyRevit()
    await write(path.join(revitTarget(), 'extension.json'), 'old')
    await write(path.join(revitTarget(), 'DG.tab', 'Stale.pushbutton', 'script.py'), 'stale')

    expect(await installer().install('revit')).toBe('ready')

    const installed = await fsp.readdir(revitTarget())
    expect(installed.sort()).toEqual([...REVIT_COPY_ENTRIES].sort())
    expect(await fsp.readFile(path.join(revitTarget(), 'extension.json'), 'utf8')).toBe('extension.json v2')
    await expect(fsp.access(path.join(revitTarget(), 'DG.tab', 'Stale.pushbutton'))).rejects.toThrow()
    await expect(fsp.access(path.join(revitTarget(), 'lib', '__pycache__'))).rejects.toThrow()

    const backup = path.join(paths.localAppData, 'DG', 'connector-backups', 'revit', utcStamp(NOW))
    expect(await fsp.readFile(path.join(backup, 'extension.json'), 'utf8')).toBe('old')
    expect(await fsp.readFile(path.join(backup, 'DG.tab', 'Stale.pushbutton', 'script.py'), 'utf8')).toBe('stale')
  })

  it('refuses a target that is not an earlier installation', async () => {
    await bundleRevit()
    await pyRevit()
    await write(path.join(revitTarget(), 'notes.txt'), 'someone else')

    expect(await installer().install('revit')).toBe('failed')
    expect(await fsp.readdir(revitTarget())).toEqual(['notes.txt'])
  })

  it('overwrites Grasshopper files in place, keeps other files and skips symbols', async () => {
    await bundleGrasshopper()
    await write(path.join(ghTarget(), 'DG.gha'), 'gha v1')
    await write(path.join(ghTarget(), 'Other.dll'), 'other')

    expect(await installer().install('grasshopper')).toBe('ready')
    expect((await fsp.readdir(ghTarget())).sort()).toEqual(['DG.Core.dll', 'DG.gha', 'Other.dll'])
    expect(await fsp.readFile(path.join(ghTarget(), 'DG.gha'), 'utf8')).toBe('gha v2')
    const backup = path.join(paths.localAppData, 'DG', 'connector-backups', 'grasshopper', utcStamp(NOW))
    expect(await fsp.readFile(path.join(backup, 'DG.gha'), 'utf8')).toBe('gha v1')
  })

  it('stops before any change when a file is held', async () => {
    await bundleGrasshopper()
    await write(path.join(ghTarget(), 'DG.gha'), 'gha v1')
    const realOpen = fsp.open
    fsp.open = (async (file: Parameters<typeof realOpen>[0], ...rest: unknown[]) => {
      if (String(file).endsWith('DG.gha')) {throw Object.assign(new Error('busy'), { code: 'EBUSY' })}

      return (realOpen as (...args: unknown[]) => unknown)(file, ...rest)
    }) as typeof realOpen

    try {
      expect(await installer().install('grasshopper')).toBe('locked')
    } finally {
      fsp.open = realOpen
    }

    expect(await fsp.readFile(path.join(ghTarget(), 'DG.gha'), 'utf8')).toBe('gha v1')
    await expect(fsp.access(path.join(paths.localAppData, 'DG'))).rejects.toThrow()
  })

  it('never installs what is not bundled', async () => {
    expect(await installer().install('grasshopper')).toBe('unavailable')
    await expect(fsp.access(ghTarget())).rejects.toThrow()
  })
})

describe('pyRevit Routes settings', () => {
  const iniPath = (): string => path.join(paths.appData, 'pyRevit', 'pyRevit_config.ini')
  const readIni = (): Promise<string> => fsp.readFile(iniPath(), 'utf8')

  it('adds the whole section when there is none and leaves other sections alone', () => {
    const { text, changed } = ensureRoutesLoopback('[core]\r\nuserlocale = ru\r\n')
    expect(changed).toBe(true)
    expect(text).toBe('[core]\r\nuserlocale = ru\r\n\r\n[routes]\r\nhost = "127.0.0.1"\r\nenabled = true\r\n')
  })

  it('adds a missing host to the user\'s own section (enabled, no host) and keeps its other keys', () => {
    const { text } = ensureRoutesLoopback('[core]\nx = 1\n\n[routes]\nenabled = true\ncore_api = false\n\n[other]\ny = 2\n')
    expect(text).toBe('[core]\nx = 1\n\n[routes]\nhost = "127.0.0.1"\nenabled = true\ncore_api = false\n\n[other]\ny = 2\n')
  })

  it('replaces a host that is not loopback and a switched-off Routes, whatever the quoting or case', () => {
    expect(ensureRoutesLoopback('[Routes]\nHost = "0.0.0.0"\nEnabled = false\n').text).toBe(
      '[Routes]\nHost = "127.0.0.1"\nEnabled = true\n'
    )
    expect(ensureRoutesLoopback('[routes]\nhost = localhost\nenabled = True\n').text).toBe(
      '[routes]\nhost = "127.0.0.1"\nenabled = True\n'
    )
  })

  it('changes nothing when the settings are already right', () => {
    for (const input of ['[routes]\nenabled = true\nhost = "127.0.0.1"\nport = 48884\n', "[routes]\nhost = '127.0.0.1'\nenabled = true"]) {
      expect(ensureRoutesLoopback(input)).toEqual({ text: input, changed: false })
    }
  })

  it('keeps a byte-order mark and makes a file from nothing', () => {
    expect(ensureRoutesLoopback('﻿[core]\r\n').text.startsWith('﻿[core]\r\n')).toBe(true)
    expect(ensureRoutesLoopback('').text).toBe('[routes]\r\nhost = "127.0.0.1"\r\nenabled = true\r\n')
  })

  it('sets Routes during the Revit install and saves the previous file', async () => {
    await bundleRevit()
    await write(iniPath(), '[core]\r\nuserlocale = ru\r\n[routes]\r\nenabled = true\r\ncore_api = false\r\n')

    const subject = installer()
    expect(await subject.status('revit')).toBe('install')
    expect(await subject.install('revit')).toBe('ready')
    expect(await readIni()).toBe(
      '[core]\r\nuserlocale = ru\r\n[routes]\r\nhost = "127.0.0.1"\r\nenabled = true\r\ncore_api = false\r\n'
    )

    const saved = path.join(paths.localAppData, 'DG', 'connector-backups', 'revit-settings', utcStamp(NOW), 'pyRevit_config.ini')
    expect(await fsp.readFile(saved, 'utf8')).toBe('[core]\r\nuserlocale = ru\r\n[routes]\r\nenabled = true\r\ncore_api = false\r\n')
    await expect(fsp.access(`${iniPath()}.degram-tmp`)).rejects.toThrow()
  })

  it('writes the settings file when pyRevit is installed but has not made one yet', async () => {
    await bundleRevit()
    await write(path.join(paths.appData, 'pyRevit-Master', 'pyRevitfile'), '')

    expect(await installer().install('revit')).toBe('ready')
    expect(await readIni()).toBe('[routes]\r\nhost = "127.0.0.1"\r\nenabled = true\r\n')
  })

  it('repairs only the settings when the extension files are already current', async () => {
    await bundleRevit()
    await pyRevit()
    const subject = installer()
    expect(await subject.install('revit')).toBe('ready')

    await fsp.writeFile(iniPath(), '[routes]\nhost = "0.0.0.0"\nenabled = true\n')
    expect(await subject.status('revit')).toBe('install')
    expect(await subject.install('revit')).toBe('ready')

    expect(await readIni()).toBe('[routes]\nhost = "127.0.0.1"\nenabled = true\n')
    await expect(fsp.access(path.join(paths.localAppData, 'DG', 'connector-backups', 'revit'))).rejects.toThrow()
  })

  it('does not rewrite a settings file that is not UTF-8', async () => {
    await bundleRevit()
    const bytes = Buffer.from([0x5b, 0x63, 0x6f, 0x72, 0x65, 0x5d, 0x0a, 0x70, 0x3d, 0xe9, 0x0a])
    await fsp.mkdir(path.dirname(iniPath()), { recursive: true })
    await fsp.writeFile(iniPath(), bytes)

    expect(await installer().install('revit')).toBe('failed')
    expect(Buffer.compare(await fsp.readFile(iniPath()), bytes)).toBe(0)
  })

  it('leaves Grasshopper without any host settings', async () => {
    await bundleGrasshopper()
    expect(await installer().install('grasshopper')).toBe('ready')
    await expect(fsp.access(path.join(paths.appData, 'pyRevit'))).rejects.toThrow()
  })
})

describe('connector helpers', () => {
  it('knows exactly the two installable connectors', () => {
    expect(isInstallableConnector('revit')).toBe(true)
    expect(isInstallableConnector('grasshopper')).toBe(true)

    for (const value of ['dynamo', 'Revit', '', null, 1, '../revit']) {expect(isInstallableConnector(value)).toBe(false)}
  })

  it('formats the backup stamp like install.py', () => {
    expect(utcStamp(NOW)).toBe('20261027T201503Z')
  })

  it('names the target in the confirmation text', () => {
    const ru = connectorConfirmation('revit', 'ru', 'C:\\x')
    expect(ru.message).toContain('Revit')
    expect(ru.detail).toContain('C:\\x')
    expect(ru.buttons).toEqual(['Установить', 'Отмена'])
    expect(connectorConfirmation('grasshopper', 'en', 'D').buttons).toEqual(['Install', 'Cancel'])
  })
})
