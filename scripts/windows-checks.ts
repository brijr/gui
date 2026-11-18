// Windows integration checks: the foundation Gui needs on Windows, exercised for real on a
// Windows machine with Gui's own modules, in Electron's main process. No agent is sent a
// prompt, so nothing here costs anything. .github/workflows/windows.yml runs it:
//
//   bun build scripts/windows-checks.ts --target=node --format=esm --external electron \
//     --external node-pty --outfile out/windows-checks/main.mjs
//   node_modules\electron\dist\electron.exe out/windows-checks/main.mjs [installed Gui.exe]
//
// With an installed Gui.exe, the ACP adapter and node-pty are started from that install,
// exactly as Gui starts them; without, from this checkout. Gui's data folder is a new
// temporary one, so a person's own Gui is never read or changed. Exits 1 if any check fails.
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { app } from 'electron'
import { agentBinaries } from './agent-binaries'

// Bundled into out/windows-checks/.
const root = join(import.meta.dirname, '..', '..')
const installed = process.argv.slice(2).find((arg) => arg.toLowerCase().endsWith('.exe'))
const data = mkdtempSync(join(tmpdir(), 'gui-windows-checks-'))
app.setPath('userData', join(data, 'Gui'))
;(globalThis as { __GUI_AGENT_BINARIES__?: unknown }).__GUI_AGENT_BINARIES__ = agentBinaries(root)

const results: { name: string; ok: boolean; ms: number; detail: string }[] = []

async function check(name: string, run: () => Promise<string>) {
  const started = performance.now()
  try {
    const detail = await run()
    results.push({ name, ok: true, ms: Math.round(performance.now() - started), detail })
    console.log(`ok   ${name} (${Math.round(performance.now() - started)} ms) ${detail}`)
  } catch (error) {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
    results.push({ name, ok: false, ms: Math.round(performance.now() - started), detail })
    console.log(`FAIL ${name}: ${detail}`)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function until<T>(what: string, ms: number, attempt: () => T | null | Promise<T | null>) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const value = await attempt()
    if (value !== null) return value
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}`)
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Arguments a shell would mangle. */
const AWKWARD = [
  'plain',
  'with space',
  'quote"inside',
  'amp&ersand',
  'percent%PATH%',
  '%',
  'caret^',
  '(parens)',
  'pipe|lt<gt>',
  'bang!',
  'trailing\\',
  'back\\"slash',
  '',
  "single'quote",
  'comma,semi;',
  'unicode é ☃',
  '  leading and trailing  ',
]

await app.whenReady()

const process_ = await import('../src/main/process')
const { findExecutable } = await import('../src/main/executables')
const { getShellEnv } = await import('../src/main/shell-env')

await check('environment comes from the process, with one PATH', async () => {
  const env = await getShellEnv()
  const pathKeys = Object.keys(env).filter((key) => key.toUpperCase() === 'PATH')
  assert(pathKeys.length === 1 && pathKeys[0] === 'PATH', `PATH keys: ${pathKeys.join(', ')}`)
  assert((env.PATH ?? '').includes(';'), 'PATH is not ;-separated')
  return `${(env.PATH ?? '').split(';').length} PATH entries`
})

// A folder whose name cmd.exe would mangle, holding a batch shim like npm's.
const awkwardDir = join(data, 'bin (x86) & co')
mkdirSync(awkwardDir, { recursive: true })
writeFileSync(
  join(awkwardDir, 'print-args.js'),
  'console.log(JSON.stringify(process.argv.slice(2)))',
)
writeFileSync(join(awkwardDir, 'gui-shim.cmd'), '@node "%~dp0print-args.js" %*\r\n')

function run(file: string, args: string[], env?: NodeJS.ProcessEnv) {
  return new Promise<string>((resolve, reject) => {
    process_.execFile(file, args, { env, encoding: 'utf8', timeout: 30_000 }, (error, stdout) =>
      error ? reject(error) : resolve(String(stdout)),
    )
  })
}

/** Runs `file` with Electron as Node (which process.ts leaves out of the env unless asked). */
function runAsNode(file: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = process_.spawnProcess(file, args, { extra: { ELECTRON_RUN_AS_NODE: '1' } })
    let out = ''
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      out += chunk
    })
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      out += chunk
    })
    const timer = setTimeout(() => child.kill(), 30_000)
    child.on('error', reject)
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(out)
      else reject(new Error(`exit ${code}: ${out}`))
    })
  })
}

function within<T>(ms: number, what: string, promise: Promise<T>) {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`${what} took over ${ms} ms`)), ms),
    ),
  ])
}

await check('a .cmd shim is found on PATH and gets awkward arguments intact', async () => {
  const env = await getShellEnv()
  const path = `${awkwardDir};${env.PATH}`
  const shim = await findExecutable('gui-shim', path)
  assert(shim && shim.toLowerCase().endsWith('gui-shim.cmd'), `found ${shim}`)
  const out = await run(shim, AWKWARD, { ...env, PATH: path })
  const got = JSON.parse(out.trim()) as string[]
  assert(JSON.stringify(got) === JSON.stringify(AWKWARD), `got ${JSON.stringify(got)}`)
  // And through spawnProcess, as agents and installs start.
  const child = process_.spawnProcess(shim, AWKWARD, { env: { ...env, PATH: path } })
  let spawned = ''
  child.stdout?.on('data', (chunk) => {
    spawned += chunk
  })
  const code = await new Promise((resolve) => child.on('exit', resolve))
  assert(code === 0, `spawnProcess exit ${code}`)
  assert(spawned.trim() === out.trim(), `spawnProcess got ${spawned}`)
  return shim
})

await check('an .exe is found on PATH and gets awkward arguments intact', async () => {
  const env = await getShellEnv()
  const node = await findExecutable('node', env.PATH)
  assert(node && node.toLowerCase().endsWith('node.exe'), `found ${node}`)
  const out = await run(node, [
    '-e',
    'console.log(JSON.stringify(process.argv.slice(1)))',
    ...AWKWARD,
  ])
  const got = JSON.parse(out.trim()) as string[]
  assert(JSON.stringify(got) === JSON.stringify(AWKWARD), `got ${JSON.stringify(got)}`)
  return node
})

await check('git is found', async () => {
  const env = await getShellEnv()
  const git = await findExecutable('git', env.PATH)
  assert(git, 'no git on PATH')
  return `${git}: ${(await run(git, ['--version'])).trim()}`
})

// Claude Code and Codex: downloaded from npm, checked against bun.lock, unpacked, run.
const agentBinaries_ = await import('../src/main/agent-binaries')
const cliPaths: Partial<Record<'claude' | 'codex', string>> = {}
for (const id of ['claude', 'codex'] as const) {
  await check(
    `the pinned ${id} is downloaded, verified, unpacked and answers --version`,
    async () => {
      const started = performance.now()
      await agentBinaries_.installAgentBinary(id, () => undefined, new AbortController().signal)
      const installMs = Math.round(performance.now() - started)
      const status = await agentBinaries_.agentBinary(id)
      assert(status.kind === 'ready', `status ${JSON.stringify(status)}`)
      assert(status.binary.source === 'gui', `source ${status.binary.source}`)
      cliPaths[id] = status.binary.path
      const version = (await run(status.binary.path, ['--version'])).trim()
      assert(version.includes(status.binary.version), `--version said ${version}`)
      return `${status.binary.path} → ${version} (install ${installMs} ms)`
    },
  )
}

// Gui's Node.js, for people without one.
await check("Gui's Node.js is set up, and node and npm (a .cmd) run through it", async () => {
  const { nodeRuntime } = await import('../src/main/node-runtime')
  const { nodeBinDir } = await import('../src/main/node-paths')
  await nodeRuntime.install()
  assert(nodeRuntime.state.status === 'ready', `state ${JSON.stringify(nodeRuntime.state)}`)
  const dir = nodeBinDir()
  const node = await findExecutable('node', dir)
  const npm = await findExecutable('npm', dir)
  assert(node && node.endsWith('node.exe'), `node: ${node}`)
  assert(npm && npm.endsWith('npm.cmd'), `npm: ${npm}`)
  const env = { ...(await getShellEnv()), PATH: `${dir};${process.env.SystemRoot}\\System32` }
  const nodeVersion = (await run(node, ['--version'], env)).trim()
  const npmVersion = (await run(npm, ['--version'], env)).trim()
  assert(/^v\d+\./.test(nodeVersion), `node --version: ${nodeVersion}`)
  assert(/^\d+\./.test(npmVersion), `npm --version: ${npmVersion}`)
  // addToPath put it at the end of everything Gui starts.
  assert((await getShellEnv()).PATH?.split(';').includes(dir), 'not on the PATH')
  return `node ${nodeVersion}, npm ${npmVersion}`
})

const { readParents, descendantsIn } = await import('../src/main/windows-processes')

await check('a terminal starts, echoes a line, and closes with everything it started', async () => {
  const { Terminals } = await import('../src/main/terminals')
  const terminals = new Terminals(data)
  const id = terminals.create()
  const text = () => terminals.output(id).data
  await until('a prompt', 30_000, () => (/PS .*>/.test(text()) ? true : null))
  // Joined in the shell, so only its output has the whole word.
  terminals.write(id, "Write-Output ('gui-' + 'terminal-ok')\r")
  await until('the echo', 15_000, () => (text().includes('gui-terminal-ok') ? true : null))
  const shell = (
    terminals as unknown as { shells: Map<string, { proc: { pid: number } | null }> }
  ).shells.get(id)?.proc?.pid
  assert(shell, 'no shell pid')
  // A job of its own, to see it ended too.
  terminals.write(id, 'Start-Process -NoNewWindow ping -ArgumentList "-n","60","127.0.0.1"\r')
  const tree = await until('the ping', 15_000, async () => {
    const parents = await readParents()
    const found = parents && descendantsIn(parents, shell)
    return found && found.size > 1 ? found : null
  })
  const started = performance.now()
  await within(15_000, 'closing the terminal', terminals.dispose())
  const ms = Math.round(performance.now() - started)
  const left = [...tree].filter(alive)
  assert(left.length === 0, `still running: ${left.join(', ')}`)
  return `shell ${shell}, ${tree.size} processes ended in ${ms} ms`
})

await check(
  'a dev server starts, its port is found, and stopping it ends its whole tree',
  async () => {
    const { DevServer } = await import('../src/main/dev-server')
    const server = new DevServer(data)
    // It prints no address: the port is found by asking Windows who listens. A child process
    // of its own makes the tree deeper than the shell and the server.
    const command = `node -e "require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); require('http').createServer((q, s) => s.end('<!doctype html><title>ok</title>')).listen(0, '127.0.0.1')"`
    const started = performance.now()
    await server.start(command)
    const url = await until('the server to be found', 60_000, () =>
      server.state.status === 'running'
        ? server.state.url
        : server.state.status === 'exited'
          ? Promise.reject(new Error(`exited: ${server.logs()}`))
          : null,
    )
    const foundMs = Math.round(performance.now() - started)
    const response = await fetch(url as string).then((r) => r.text())
    assert(response.includes('<title>ok</title>'), `served ${response}`)
    const shell = (server as unknown as { proc: { pid: number } | null }).proc?.pid
    assert(shell, 'no shell pid')
    const parents = await readParents()
    assert(parents, 'no process table')
    const tree = descendantsIn(parents, shell)
    assert(tree.size >= 3, `tree ${[...tree].join(', ')}`)
    const stopStarted = performance.now()
    await within(15_000, 'stopping the server', server.stopAndWait())
    const stopMs = Math.round(performance.now() - stopStarted)
    const left = [...tree].filter(alive)
    assert(left.length === 0, `still running: ${left.join(', ')}`)
    assert(server.state.status === 'idle', `status ${server.state.status}`)
    await server.dispose()
    return `${url} found in ${foundMs} ms; ${tree.size} processes stopped in ${stopMs} ms`
  },
)

await check('port lookups are quick', async () => {
  const ports = await import('../src/main/ports')
  const times: number[] = []
  for (let i = 0; i < 5; i++) {
    const started = performance.now()
    await ports.listenersOf(process.pid)
    times.push(Math.round(performance.now() - started))
  }
  const onStarted = performance.now()
  await ports.listenersOn(445)
  const on = Math.round(performance.now() - onStarted)
  const tableStarted = performance.now()
  await readParents()
  const table = Math.round(performance.now() - tableStarted)
  return `listenersOf ${times.join('/')} ms; listenersOn ${on} ms; process table ${table} ms`
})

// The ACP adapters run on Gui's own Electron, as Node (agent.ts spawnSpec).
function adapterEntry(name: string) {
  if (!installed) return join(root, 'node_modules', name, 'dist', 'index.js')
  return join(
    dirname(installed),
    'resources',
    'app.asar.unpacked',
    'node_modules',
    name,
    'dist',
    'index.js',
  )
}

for (const [id, name, cliEnv] of [
  ['claude', '@agentclientprotocol/claude-agent-acp', 'CLAUDE_CODE_EXECUTABLE'],
  ['codex', '@agentclientprotocol/codex-acp', 'CODEX_PATH'],
] as const) {
  await check(`the ${id} ACP adapter starts on Gui's Electron and answers initialize`, async () => {
    const entry = adapterEntry(name)
    assert(existsSync(entry), `no adapter at ${entry}`)
    const bootstrap = `delete process.env.ELECTRON_RUN_AS_NODE; import(${JSON.stringify(pathToFileURL(entry).href)}).catch((error) => { console.error(error); process.exit(1) })`
    const env = await getShellEnv()
    const child = process_.spawnProcess(installed ?? process.execPath, ['-e', bootstrap], {
      cwd: data,
      env,
      extra: { ELECTRON_RUN_AS_NODE: '1', [cliEnv]: cliPaths[id] },
      browser: 'none',
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000)
    })
    const started = performance.now()
    child.stdin?.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 1,
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
          clientInfo: { name: 'gui-windows-checks', version: '0' },
        },
      })}\n`,
    )
    try {
      const response = await until('the initialize response', 60_000, () => {
        if (child.exitCode !== null) throw new Error(`exited ${child.exitCode}: ${stderr}`)
        const line = stdout.split('\n').find((l) => l.includes('"id":1'))
        return line ? (JSON.parse(line) as { result?: { protocolVersion?: number } }) : null
      })
      const ms = Math.round(performance.now() - started)
      assert(response.result?.protocolVersion, `response ${JSON.stringify(response)}`)
      // What else it says on its own (Claude's adapter checks sign-in with the CLI).
      await new Promise((resolve) => setTimeout(resolve, 5000))
      const notes = stdout
        .split('\n')
        .filter((l) => l.trim() && !l.includes('"id":1'))
        .map((l) => l.slice(0, 300))
      return `protocol ${response.result.protocolVersion} in ${ms} ms; then: ${notes.join(' | ') || 'nothing'}; stderr: ${stderr.slice(-300).trim() || 'none'}`
    } finally {
      const pid = child.pid
      if (pid) process_.killProcessGroup(pid, 'SIGTERM', child.exitCode === null)
    }
  })
}

if (installed) {
  await check("node-pty from the installed Gui starts a PTY on Gui's Electron", async () => {
    const pty = join(
      dirname(installed),
      'resources',
      'app.asar.unpacked',
      'node_modules',
      'node-pty',
    )
    const script = `const p = require(${JSON.stringify(pty)}).spawn('cmd.exe', ['/d', '/c', 'echo pty-ok'], {}); let out = ''; p.onData((d) => { out += d }); p.onExit(() => { console.log(out.includes('pty-ok') ? 'PTY-OK' : 'PTY-BAD ' + JSON.stringify(out)); process.exit(0) })`
    const out = await runAsNode(installed, ['-e', script]).catch(
      (error: Error) => `error ${error.message}`,
    )
    assert(out.includes('PTY-OK'), out)
    return 'PTY-OK'
  })
}

const failed = results.filter((result) => !result.ok)
console.log(`\n${results.length - failed.length} of ${results.length} Windows checks passed.`)
if (process.env.GITHUB_STEP_SUMMARY) {
  const rows = results.map(
    (r) =>
      `| ${r.ok ? '✅' : '❌'} | ${r.name} | ${r.ms} | ${r.detail.split('\n')[0]?.replaceAll('|', '\\|').slice(0, 400)} |`,
  )
  writeFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Windows checks\n\n| | Check | ms | Detail |\n|---|---|---|---|\n${rows.join('\n')}\n`,
    { flag: 'a' },
  )
}
rmSync(data, { recursive: true, force: true, maxRetries: 5 })
app.exit(failed.length > 0 ? 1 : 0)
