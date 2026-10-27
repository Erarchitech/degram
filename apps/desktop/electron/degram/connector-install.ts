// connector-install.ts — install the bundled DG connectors from the DeGram Connectors tab (quick 261027-sgc).
//
// DeGram carries two add-in payloads next to the agent payload:
//
//   * `resources/revit-mcp`      the DG Revit connector; its pyRevit half is copied to
//                                `%APPDATA%\pyRevit\Extensions\dg-revit-connector.extension` (the copy set of
//                                apps/dg-revit-connector/install.py; the MCP half stays where DeGram runs it);
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

export function createConnectorInstaller(deps: ConnectorInstallerDeps): ConnectorInstaller {
  const { paths, logger } = deps
  const now = deps.now ?? ((): Date => new Date())

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
        (await exists(path.join(paths.appData, 'pyRevit', 'pyRevit_config.ini')))
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

    for (const file of files) {
      if (!(await sameFile(path.join(spec.source, file), path.join(spec.target, file)))) {
        return 'install'
      }
    }

    return 'ready'
  }

  /** A free folder below the backup root: `<stamp>`, then `<stamp>-2`, ... */
  const backupFolder = async (id: InstallableConnector): Promise<string> => {
    const base = path.join(paths.localAppData, 'DG', 'connector-backups', id, utcStamp(now()))
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
          detail: `Расширение pyRevit будет скопировано в ${target}. Прежняя версия сохранится в резервной копии. После установки перезагрузите pyRevit (вкладка pyRevit → Reload) или перезапустите Revit.`,
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
        detail: `The pyRevit extension is copied to ${target}. The previous version is kept as a backup. Afterwards reload pyRevit (pyRevit tab → Reload) or restart Revit.`,
        buttons: ['Install', 'Cancel']
      }
    : {
        title: 'Install connector',
        message: 'Install the DG plugin for Grasshopper?',
        detail: `The plugin is copied to ${target}. The previous version is kept as a backup. Close Rhino before installing and start it again afterwards.`,
        buttons: ['Install', 'Cancel']
      }
}
