import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { parse } from '@babel/parser'

const root = resolve(import.meta.dirname, '..')
const source = join(root, 'src')
const files: string[] = []
function collect(directory: string) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) collect(path)
    else if (/\.tsx?$/.test(entry.name)) files.push(path)
  }
}
collect(source)
const graph = new Map<string, Set<string>>()
const failures: string[] = []
const name = (path: string) => relative(root, path)

function resolveLocal(from: string, specifier: string) {
  if (!specifier.startsWith('.')) return null
  const base = resolve(dirname(from), specifier)
  return (
    [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')].find(
      (path) => /\.tsx?$/.test(path) && existsSync(path),
    ) ?? null
  )
}
function layer(path: string) {
  return relative(source, path).split('/')[0]
}
function edge(from: string, specifier: string, runtime: boolean) {
  const target = resolveLocal(from, specifier)
  const owner = layer(from)
  if (owner === 'shared' && /^(electron|react)(\/|$)/.test(specifier))
    failures.push(`${name(from)} imports platform/UI package ${specifier}`)
  if (!target) return
  const destination = layer(target)
  if (
    (owner === 'shared' && destination !== 'shared') ||
    (owner === 'renderer' && ['main', 'preload'].includes(destination)) ||
    (owner === 'main' && ['renderer', 'preload'].includes(destination)) ||
    (owner === 'preload' && ['main', 'renderer'].includes(destination))
  )
    failures.push(`${name(from)} crosses the ${owner} → ${destination} boundary: ${name(target)}`)
  if (runtime) graph.get(from)?.add(target)
  if (
    runtime &&
    /\/chat\/(store|proposal-state|shipping-state)\.ts$/.test(from) &&
    target.endsWith('.tsx')
  )
    failures.push(`${name(from)} loads a UI component module: ${name(target)}`)
}

// Parse TypeScript syntax rather than matching import text: `import type`, mixed named
// imports, reexports, dynamic imports, and import() types have different runtime effects.
function inspect(from: string, value: unknown) {
  if (!value || typeof value !== 'object') return
  const node = value as Record<string, unknown>
  const type = node.type
  const literal = (value: unknown): string | null => {
    if (!value || typeof value !== 'object') return null
    const text = (value as { value?: unknown }).value
    return typeof text === 'string' ? text : null
  }
  if (
    type === 'ImportDeclaration' ||
    type === 'ExportNamedDeclaration' ||
    type === 'ExportAllDeclaration'
  ) {
    const specifier = literal(node.source)
    if (specifier) {
      const items = node.specifiers as
        | Array<{ importKind?: string; exportKind?: string }>
        | undefined
      const allTypes =
        Boolean(items?.length) &&
        items?.every((item) => item.importKind === 'type' || item.exportKind === 'type')
      edge(from, specifier, node.importKind !== 'type' && node.exportKind !== 'type' && !allTypes)
    }
  } else if (type === 'ImportExpression') {
    const specifier = literal(node.source)
    if (specifier) edge(from, specifier, true)
  } else if (type === 'TSImportType') {
    const specifier = literal(node.argument)
    if (specifier) edge(from, specifier, false)
  } else if (type === 'CallExpression') {
    const callee = node.callee as { type?: string; name?: string } | undefined
    if (callee?.type === 'Import' || (callee?.type === 'Identifier' && callee.name === 'require')) {
      const specifier = literal((node.arguments as unknown[] | undefined)?.[0])
      if (specifier) edge(from, specifier, true)
    }
  }
  for (const [key, child] of Object.entries(node)) {
    if (['loc', 'start', 'end', 'comments', 'tokens'].includes(key)) continue
    if (Array.isArray(child)) for (const item of child) inspect(from, item)
    else if (typeof child === 'object') inspect(from, child)
  }
}
for (const file of files) graph.set(file, new Set())
for (const file of files) {
  const tree = parse(readFileSync(file, 'utf8'), {
    sourceType: 'module',
    plugins: ['typescript', 'jsx'],
  })
  inspect(file, tree.program)
}

const visited = new Set<string>()
const active = new Set<string>()
const stack: string[] = []
function visit(file: string) {
  if (active.has(file)) {
    failures.push(
      `Runtime import cycle: ${[...stack.slice(stack.indexOf(file)), file].map(name).join(' → ')}`,
    )
    return
  }
  if (visited.has(file)) return
  visited.add(file)
  active.add(file)
  stack.push(file)
  for (const dependency of graph.get(file) ?? []) visit(dependency)
  stack.pop()
  active.delete(file)
}
for (const file of files) visit(file)

const processModule = join(source, 'main', 'process.ts')
for (const file of files) {
  if (file === processModule) continue
  const contents = readFileSync(file, 'utf8')
  if (
    /from ['"]node:child_process['"]/.test(contents) ||
    /from ['"]child_process['"]/.test(contents)
  )
    failures.push(
      `${name(file)} imports child_process; spawn and exec go through src/main/process.ts`,
    )
  if (contents.includes('DOM.getNodeForLocation') && !file.endsWith(`${sep}inspector.ts`))
    failures.push(`${name(file)} looks up nodes by location; that stays in inspector.ts`)
}

const specs: string[] = []
function collectSpecs(directory: string) {
  if (!existsSync(directory)) return
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'fixtures' || entry.name === 'node_modules') continue
      collectSpecs(path)
    } else if (entry.name.endsWith('.spec.ts')) specs.push(path)
  }
}
collectSpecs(join(root, 'e2e'))
for (const file of specs) {
  const contents = readFileSync(file, 'utf8')
  if (contents.includes('waitForTimeout'))
    failures.push(
      `${name(file)} uses waitForTimeout; wait for a condition (e2e/helpers/env.ts waitFor) or see .cursor/skills/e2e-motion`,
    )
}

if (failures.length) {
  for (const failure of new Set(failures)) console.error(failure)
  process.exitCode = 1
} else
  console.log(
    `Architecture boundaries, spawn, e2e waits, and runtime import cycles checked across ${files.length} TypeScript modules and ${specs.length} e2e specs.`,
  )
