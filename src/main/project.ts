import { access, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { PackageManager, ProjectInfo } from '../shared/types'

const LOCKFILES: [string, PackageManager][] = [
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
]

const DEV_SCRIPTS = ['dev', 'develop', 'start', 'serve']

interface PackageJson {
  name?: string
  packageManager?: string
  scripts?: Record<string, string>
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  )

async function readPackageJson(root: string): Promise<PackageJson | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as PackageJson) : null
  } catch {
    return null
  }
}

async function detectPackageManager(root: string, pkg: PackageJson | null) {
  const declared = pkg?.packageManager?.split('@')[0]
  if (declared === 'bun' || declared === 'pnpm' || declared === 'yarn' || declared === 'npm') {
    return declared
  }
  for (const [file, pm] of LOCKFILES) {
    if (await exists(join(root, file))) return pm
  }
  return 'npm'
}

export async function detectProject(root: string): Promise<ProjectInfo> {
  const pkg = await readPackageJson(root)
  const packageManager = await detectPackageManager(root, pkg)
  const script = DEV_SCRIPTS.find((name) => pkg?.scripts?.[name])
  return {
    root,
    name: pkg?.name || basename(root),
    packageManager,
    devCommand: script ? `${packageManager} run ${script}` : null,
    devScript: script ? (pkg?.scripts?.[script] ?? null) : null,
  }
}
