// connector-install.ts — install the bundled DG connectors from the DeGram Connectors tab (quick 261027-sgc).
//
// DeGram carries two add-in payloads next to the agent payload:
//
//   * `resources/revit-mcp`      the DG Revit connector; its pyRevit half is copied to
//                                `%APPDATA%\pyRevit\Extensions\dg-revit-connector.extension` (the copy set of
//                                apps/dg-revit-connector/install.py; the MCP half stays where DeGram runs it).
//                                The same install sets `[routes]` in `%APPDATA%\pyRevit\pyRevit_config.ini`
//                                (`enabled = true`, `host = "127.0.0.1"`): the connector registers no routes and
//                                the agent refuses every read while pyRevit Routes answer on any other address,
//                                so a user is never asked to edit the file by hand;
//   * `resources/dg-grasshopper` the DG Grasshopper plugin (`DG.gha` and its DLLs), copied to
//                                `%APPDATA%\Grasshopper\Libraries\DG`.
//
// The request arrives from the untrusted DG page; the runtime asks the user in a native dialog before `install`
// is called. This module only knows the two fixed packages and the fixed targets: nothing from the page reaches a
// path. A target that exists but is not ours is refused, a held file stops the install before anything changes,
// and an existing installation is backed up under `%LOCALAPPDATA%\DG\connector-backups\<id>\<UTC stamp>`.

import { createHash } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'

import type { Logger } from './dg-session'
import type { DgLocale } from './dg-view'

export const INSTALLABLE_CONNECTORS = ['revit', 'grasshopper'] as const
export type InstallableConnector = (typeof INSTALLABLE_CONNECTORS)[number]

/** The page vocabulary of `#degram-installed=` (ui-v2/src/lib/hostMode.js). */
export const CONNECTOR_INSTALL_STATES = [
  'ready',
  'install',
  'installing',
  'unavailable',
  'needs-host',
  'locked',
  'failed'
] as const
export type ConnectorInstallState = (typeof CONNECTOR_INSTALL_STATES)[number]

export type ConnectorStates = Record<InstallableConnector, ConnectorInstallState>

export interface ConnectorInstallPaths {
  /** `process.resourcesPath` of the running DeGram. */
  resourcesPath: string
  /** `%APPDATA%` (Roaming). */
  appData: string
  /** `%LOCALAPPDATA%`; backups go below it. */
  localAppData: string
  /** `%PROGRAMDATA%`, where an all-users pyRevit lives. */
  programData?: string
}

export interface ConnectorInstallerDeps {
  paths: ConnectorInstallPaths
  logger: Logger
  now?: () => Date
}

export interface ConnectorInstaller {
  /** The folder a connector installs into (shown in the confirmation dialog). */
  targetFor: (id: InstallableConnector) => string
  status: (id: InstallableConnector) => Promise<ConnectorInstallState>
  statusAll: () => Promise<ConnectorStates>
  /** Copy the bundled package into place; resolves to the state afterwards (never throws). */
  install: (id: InstallableConnector) => Promise<ConnectorInstallState>
}

export function isInstallableConnector(value: unknown): value is InstallableConnector {
  return typeof value === 'string' && (INSTALLABLE_CONNECTORS as readonly string[]).includes(value)
}

/** What the extension needs at runtime: `COPY_ENTRIES` of apps/dg-revit-connector/install.py. */
export const REVIT_COPY_ENTRIES = [
  'extension.json',
  'startup.py',
  'dg_transport.py',
  'dg_revit_mcp',
  'lib',
  'DG.tab',
  'DG_SharedParameters.txt'
] as const

/** The only address pyRevit Routes may listen on (dg_transport.is_loopback_host, spec/SECURITY-BOUNDARY.md). */
export const ROUTES_HOST = '127.0.0.1'

const SECTION_HEADER = /^\s*\[([^\]]*)\]\s*$/
const ROUTES_KEY = /^(\s*)(host|enabled)(\s*[=:]\s*)(.*?)\s*$/i

function unquote(value: string): string {
  return value.trim().replace(/^(["'])(.*)\1$/, '$2').trim()
}

/**
 * `pyRevit_config.ini` with `[routes]` made to read `enabled = true` and `host = "127.0.0.1"`; every other line,
 * the line endings and a BOM stay as they are. `changed` is false (and `text` the input) when nothing had to move.
 * The quoted host is the form pyRevit itself writes and docs/degram/CLEAN-INSTALL.md shows.
 */
export function ensureRoutesLoopback(input: string): { text: string; changed: boolean } {
  const bom = input.startsWith('﻿') ? '﻿' : ''
  const body = bom ? input.slice(1) : input
  const eol = body.includes('\r\n') || body.length === 0 ? '\r\n' : '\n'
  const lines = body.length > 0 ? body.split(/\r?\n/) : []

  if (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop()
  }

  const wanted = { host: `"${ROUTES_HOST}"`, enabled: 'true' } as const

  const isRight = (key: 'host' | 'enabled', value: string): boolean =>
    key === 'host' ? unquote(value) === ROUTES_HOST : unquote(value).toLowerCase() === 'true'

  const start = lines.findIndex(line => SECTION_HEADER.exec(line)?.[1].trim().toLowerCase() === 'routes')
  let changed = false

  if (start === -1) {
    if (lines.length > 0 && lines[lines.length - 1].trim() !== '') {
      lines.push('')
    }

    lines.push('[routes]', `host = ${wanted.host}`, `enabled = ${wanted.enabled}`)
    changed = true
  } else {
    let end = lines.findIndex((line, index) => index > start && SECTION_HEADER.test(line))
    end = end === -1 ? lines.length : end
    const seen = new Set<'host' | 'enabled'>()

    for (let index = start + 1; index < end; index += 1) {
      const match = ROUTES_KEY.exec(lines[index])

      if (!match) {
        continue
      }

      const key = match[2].toLowerCase() as 'host' | 'enabled'
      seen.add(key)

      if (!isRight(key, match[4])) {
        lines[index] = `${match[1]}${match[2]}${match[3]}${wanted[key]}`
        changed = true
      }
    }

    const missing = (['host', 'enabled'] as const).filter(key => !seen.has(key)).map(key => `${key} = ${wanted[key]}`)

    if (missing.length > 0) {
      lines.splice(start + 1, 0, ...missing)
      changed = true
    }
  }

  return changed ? { text: `${bom}${lines.join(eol)}${eol}`, changed } : { text: input, changed }
}

const SKIP_DIRECTORIES = new Set(['__pycache__', '.git', '.pytest_cache'])
const SKIP_SUFFIXES = ['.pyc', '.pyo', '.pdb']
const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES'])

interface ConnectorSpec {
  source: string
  target: string
  /** Top-level entries to copy; `null` copies every file of the source. */
  entries: readonly string[] | null
  /** The file that marks an existing target as an earlier installation of ours. */
  marker: string
  /** Replace the whole folder (stale files go) or overwrite file by file (other files stay). */
  replace: boolean
  hostPresent: () => Promise<boolean>
  /** Host-side settings the connector needs besides its files (pyRevit Routes); absent when it needs none. */
  settings?: {
    /** True when the host already has them. */
    ok: () => Promise<boolean>
    /** Set them, saving the previous file below `backupRoot`. */
    apply: (backupRoot: string) => Promise<void>
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fsp.access(file)

    return true
  } catch {
    return false
  }
}

async function isDirectory(file: string): Promise<boolean> {
  try {
    return (await fsp.stat(file)).isDirectory()
  } catch {
    return false
  }
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await fsp.readFile(file)).digest('hex')
}

function errorCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : ''
}

/** `yyyymmddTHHMMSSZ`, the stamp install.py uses. */
export function utcStamp(moment: Date): string {
  return moment.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
}

/** Every file below `root` as a relative path, sorted; generated files are skipped. */
async function walk(root: string, relative = ''): Promise<string[]> {
  const found: string[] = []
  const entries = await fsp.readdir(path.join(root, relative), { withFileTypes: true })

  for (const entry of entries) {
    const child = relative ? path.join(relative, entry.name) : entry.name

    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) {
        found.push(...(await walk(root, child)))
      }
    } else if (entry.isFile() && !SKIP_SUFFIXES.some(suffix => entry.name.toLowerCase().endsWith(suffix))) {
      found.push(child)
    }
  }

  return found.sort()
}

/** The files a package installs, or `null` when the bundled package is missing or incomplete. */
async function packageFiles(spec: ConnectorSpec): Promise<string[] | null> {
  if (!(await isDirectory(spec.source))) {
    return null
  }

  if (!spec.entries) {
    return (await exists(path.join(spec.source, spec.marker))) ? walk(spec.source) : null
  }

  const files: string[] = []

  for (const entry of spec.entries) {
    const absolute = path.join(spec.source, entry)

    if (await isDirectory(absolute)) {
      files.push(...(await walk(spec.source, entry)))
    } else if (await exists(absolute)) {
      files.push(entry)
    } else {
      return null
    }
  }

  return files.sort()
}

async function sameFile(source: string, target: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([fsp.stat(source), fsp.stat(target)])

    return a.size === b.size && (await sha256(source)) === (await sha256(target))
  } catch {
    return false
  }
}

/** True when every file of the package is already in the target with the same content. */
async function filesCurrent(spec: ConnectorSpec, files: string[]): Promise<boolean> {
  for (const file of files) {
    if (!(await sameFile(path.join(spec.source, file), path.join(spec.target, file)))) {
      return false
    }
  }

  return true
}

export function createConnectorInstaller(deps: ConnectorInstallerDeps): ConnectorInstaller {
  const { paths, logger } = deps
  const now = deps.now ?? ((): Date => new Date())

  const routesConfig = path.join(paths.appData, 'pyRevit', 'pyRevit_config.ini')

  /** The pyRevit settings file ('' when there is none yet); a file that is not UTF-8 is never rewritten. */
  const readRoutesConfig = async (): Promise<string> => {
    let bytes: Buffer

    try {
      bytes = await fsp.readFile(routesConfig)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        return ''
      }

      throw error
    }

    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw new Error('pyRevit_config.ini is not UTF-8; it was left unchanged')
    }
  }

  const routesSettings: NonNullable<ConnectorSpec['settings']> = {
    ok: async () => {
      try {
        return !ensureRoutesLoopback(await readRoutesConfig()).changed
      } catch {
        return false
      }
    },
    apply: async backupRoot => {
      const current = await readRoutesConfig()
      const { text, changed } = ensureRoutesLoopback(current)

      if (!changed) {
        return
      }

      if (current.length > 0) {
        await fsp.mkdir(backupRoot, { recursive: true })
        await fsp.copyFile(routesConfig, path.join(backupRoot, 'pyRevit_config.ini'))
      }

      await fsp.mkdir(path.dirname(routesConfig), { recursive: true })
      const temp = `${routesConfig}.degram-tmp`

      try {
        await fsp.writeFile(temp, text, 'utf8')
        await fsp.rename(temp, routesConfig)
      } catch (error) {
        await fsp.rm(temp, { force: true })

        throw error
      }

      logger.info(`[degram] connector revit: pyRevit Routes set to enabled, host ${ROUTES_HOST} in ${routesConfig}`)
    }
  }

  const specs: Record<InstallableConnector, ConnectorSpec> = {
    revit: {
      source: path.join(paths.resourcesPath, 'revit-mcp'),
      target: path.join(paths.appData, 'pyRevit', 'Extensions', 'dg-revit-connector.extension'),
      entries: REVIT_COPY_ENTRIES,
      marker: 'extension.json',
      replace: true,
      hostPresent: async () =>
        (await exists(path.join(paths.appData, 'pyRevit-Master'))) ||
        (paths.programData ? await exists(path.join(paths.programData, 'pyRevit-Master')) : false) ||
        (await exists(routesConfig)),
      settings: routesSettings
    },
    grasshopper: {
      source: path.join(paths.resourcesPath, 'dg-grasshopper'),
      target: path.join(paths.appData, 'Grasshopper', 'Libraries', 'DG'),
      entries: null,
      marker: 'DG.gha',
      replace: false,
      hostPresent: async () => true
    }
  }

  const status = async (id: InstallableConnector): Promise<ConnectorInstallState> => {
    const spec = specs[id]
    const files = await packageFiles(spec)

    if (!files || files.length === 0) {
      return 'unavailable'
    }

    if (!(await spec.hostPresent())) {
      return 'needs-host'
    }

    if (!(await filesCurrent(spec, files))) {
      return 'install'
    }

    return spec.settings && !(await spec.settings.ok()) ? 'install' : 'ready'
  }

  /** A free folder below the backup root: `<stamp>`, then `<stamp>-2`, ... */
  const backupFolder = async (name: string): Promise<string> => {
    const base = path.join(paths.localAppData, 'DG', 'connector-backups', name, utcStamp(now()))
    let candidate = base

    for (let counter = 2; await exists(candidate); counter += 1) {
      candidate = `${base}-${counter}`
    }

    return candidate
  }

  /** Open every file that will be overwritten; a held one means Rhino or Revit still uses it. */
  const heldFile = async (spec: ConnectorSpec, files: string[]): Promise<boolean> => {
    for (const file of files) {
      const target = path.join(spec.target, file)

      if (!(await exists(target))) {
        continue
      }

      try {
        const handle = await fsp.open(target, 'r+')
        await handle.close()
      } catch (error) {
        if (LOCK_CODES.has(errorCode(error))) {
          return true
        }

        throw error
      }
    }

    return false
  }

  const install = async (id: InstallableConnector): Promise<ConnectorInstallState> => {
    const spec = specs[id]

    try {
      const before = await status(id)

      if (before === 'unavailable' || before === 'needs-host') {
        return before
      }

      const files = (await packageFiles(spec)) ?? []

      // Files already in place (only the host settings are off): nothing is moved, backed up or overwritten.
      if (await filesCurrent(spec, files)) {
        await spec.settings?.apply(await backupFolder(`${id}-settings`))

        return status(id)
      }

      const present = await exists(spec.target)

      if (present) {
        if (!(await isDirectory(spec.target))) {
          logger.warn(`[degram] connector ${id}: the install target is not a folder; nothing was changed`)

          return 'failed'
        }

        const existing = await fsp.readdir(spec.target)

        if (existing.length > 0 && !existing.includes(spec.marker)) {
          logger.warn(`[degram] connector ${id}: the install target holds no ${spec.marker}; it is not ours to replace`)

          return 'failed'
        }

        if (await heldFile(spec, files)) {
          return 'locked'
        }

        const backup = await backupFolder(id)
        await fsp.mkdir(path.dirname(backup), { recursive: true })

        if (spec.replace) {
          try {
            await fsp.rename(spec.target, backup)
          } catch (error) {
            if (LOCK_CODES.has(errorCode(error))) {
              return 'locked'
            }

            if (errorCode(error) !== 'EXDEV') {
              throw error
            }

            await fsp.cp(spec.target, backup, { recursive: true })
            await fsp.rm(spec.target, { recursive: true, force: true })
          }
        } else {
          await fsp.cp(spec.target, backup, { recursive: true })
        }

        logger.info(`[degram] connector ${id}: the previous installation was saved to ${backup}`)
      }

      for (const file of files) {
        const destination = path.join(spec.target, file)
        await fsp.mkdir(path.dirname(destination), { recursive: true })
        await fsp.copyFile(path.join(spec.source, file), destination)
      }

      logger.info(`[degram] connector ${id}: ${files.length} files installed to ${spec.target}`)

      await spec.settings?.apply(await backupFolder(`${id}-settings`))

      return status(id)
    } catch (error) {
      const code = errorCode(error)
      logger.warn(`[degram] connector ${id}: install failed (${code || (error instanceof Error ? error.message : 'unknown')})`)

      return LOCK_CODES.has(code) ? 'locked' : 'failed'
    }
  }

  return {
    targetFor: id => specs[id].target,
    status,
    statusAll: async () => ({ revit: await status('revit'), grasshopper: await status('grasshopper') }),
    install
  }
}

/** The text of the native confirmation dialog. */
export function connectorConfirmation(
  id: InstallableConnector,
  locale: DgLocale,
  target: string
): { title: string; message: string; detail: string; buttons: [string, string] } {
  if (locale === 'ru') {
    return id === 'revit'
      ? {
          title: 'Установка коннектора',
          message: 'Установить коннектор DG для Revit?',
          detail: `Расширение pyRevit будет скопировано в ${target}. В настройках pyRevit (pyRevit_config.ini) DeGram сам включит Routes и ограничит их адресом 127.0.0.1. Прежние версии сохранятся в резервных копиях. После установки перезапустите Revit.`,
          buttons: ['Установить', 'Отмена']
        }
      : {
          title: 'Установка коннектора',
          message: 'Установить плагин DG для Grasshopper?',
          detail: `Плагин будет скопирован в ${target}. Прежняя версия сохранится в резервной копии. Закройте Rhino перед установкой и запустите его снова после неё.`,
          buttons: ['Установить', 'Отмена']
        }
  }

  return id === 'revit'
    ? {
        title: 'Install connector',
        message: 'Install the DG connector for Revit?',
        detail: `The pyRevit extension is copied to ${target}. DeGram also turns pyRevit Routes on and limits them to 127.0.0.1 in the pyRevit settings (pyRevit_config.ini). Previous versions are kept as backups. Afterwards restart Revit.`,
        buttons: ['Install', 'Cancel']
      }
    : {
        title: 'Install connector',
        message: 'Install the DG plugin for Grasshopper?',
        detail: `The plugin is copied to ${target}. The previous version is kept as a backup. Close Rhino before installing and start it again afterwards.`,
        buttons: ['Install', 'Cancel']
      }
}
