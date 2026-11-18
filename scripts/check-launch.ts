// Starts a packaged Linux Gui the way a person does, waits for its window to load, and quits it
// the way logging out does (SIGTERM), which must end it with exit code 0.
// .github/workflows/release-linux.yml runs it on each AppImage, under xvfb, before anything is
// uploaded:
//
//   xvfb-run -a bun scripts/check-launch.ts release/Gui-<version>-x86_64.AppImage
//
// On Windows (.github/workflows/windows.yml) it starts an installed Gui.exe and quits it by
// closing its window, as taskkill without /F asks (Windows has no SIGTERM); that too must end
// it with exit code 0.
//
// Gui gets a new, empty data folder with crash reports off, so this never reads or changes a
// person's own Gui data and a failure here never reaches usegui.com. A DevTools port is how this
// script sees the window's page.
import { execFileSync, spawn } from 'node:child_process'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

/** Mounting the AppImage and the first start on a CI runner take a while. */
const START_WAIT = 120_000
const QUIT_WAIT = 30_000

const IS_WINDOWS = process.platform === 'win32'
const app = process.argv[2]
if (!app) {
  console.error('usage: bun scripts/check-launch.ts <Gui AppImage, or Gui.exe on Windows>')
  process.exit(2)
}

const data = mkdtempSync(join(tmpdir(), 'gui-launch-'))
writeFileSync(join(data, 'prefs.json'), JSON.stringify({ crashReports: false }))

const child = spawn(resolve(app), [`--user-data-dir=${data}`, '--remote-debugging-port=0'], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
let output = ''
const collect = (chunk: Buffer) => {
  output += chunk.toString()
  // Only the end is printed on failure.
  if (output.length > 200_000) output = output.slice(-100_000)
}
child.stdout.on('data', collect)
child.stderr.on('data', collect)
/** How Gui ended, once it has */
let ended: string | null = null
const exited = new Promise<string>((done) => {
  child.on('exit', (code, signal) => {
    ended = signal ? `signal ${signal}` : `exit code ${code}`
    done(ended)
  })
  child.on('error', (error) => {
    ended = error.message
    done(ended)
  })
})

function fail(message: string): never {
  console.error(`check-launch: ${message}`)
  console.error('Gui printed (last 60 lines):')
  console.error(output.split('\n').slice(-60).join('\n'))
  for (const pid of guiProcesses()) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  child.kill('SIGKILL')
  rmSync(data, { recursive: true, force: true })
  process.exit(1)
}

/** Windows: each process's pid and command line, from PowerShell (there's no /proc). */
function windowsProcesses() {
  const script =
    'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }'
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      },
    )
    return out.split(/\r?\n/).flatMap((line) => {
      const tab = line.indexOf('\t')
      return tab > 0 ? [{ pid: Number(line.slice(0, tab)), args: line.slice(tab + 1) }] : []
    })
  } catch {
    return []
  }
}

/** Every process started with this data folder: Gui and its helpers, and the AppImage runtime. */
function guiProcesses() {
  if (IS_WINDOWS) {
    return windowsProcesses()
      .filter((proc) => proc.args.includes(`--user-data-dir=${data}`))
      .map((proc) => proc.pid)
  }
  const pids: number[] = []
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const args = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0')
      if (args.includes(`--user-data-dir=${data}`)) pids.push(Number(entry))
    } catch {
      // It ended while this looked.
    }
  }
  return pids
}

/** Gui's main process: its `gui` executable, not a helper (`--type=…`) or the AppImage runtime. */
function mainProcess() {
  if (IS_WINDOWS) {
    const main = windowsProcesses().find(
      (proc) => proc.args.includes(`--user-data-dir=${data}`) && !proc.args.includes('--type='),
    )
    return main?.pid ?? null
  }
  for (const pid of guiProcesses()) {
    try {
      const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0')
      const exe = readlinkSync(`/proc/${pid}/exe`)
      if (basename(exe) === 'gui' && !args.some((arg) => arg.startsWith('--type='))) return pid
    } catch {}
  }
  return null
}

const started = Date.now()
const deadline = started + START_WAIT
async function until<T>(what: string, attempt: () => Promise<T | null> | T | null): Promise<T> {
  while (Date.now() < deadline) {
    if (ended !== null) fail(`Gui ended (${ended}) before ${what}.`)
    const result = await attempt()
    if (result !== null) return result
    await sleep(500)
  }
  fail(`Gui didn't get to ${what} within ${START_WAIT / 1000} seconds.`)
}

// Chromium says where DevTools listens, on stderr and in DevToolsActivePort.
const port = await until('opening its DevTools port', () => {
  const said = output.match(/DevTools listening on ws:\/\/[\w.]+:(\d+)\//)?.[1]
  if (said) return Number(said)
  try {
    return Number(readFileSync(join(data, 'DevToolsActivePort'), 'utf8').split('\n')[0]) || null
  } catch {
    return null
  }
})

interface Target {
  type: string
  url: string
  webSocketDebuggerUrl?: string
}
const page = await until('opening its window', async () => {
  const targets = (await fetch(`http://127.0.0.1:${port}/json/list`)
    .then((response) => response.json())
    .catch(() => [])) as Target[]
  return (
    targets.find(
      (target) =>
        target.type === 'page' &&
        target.url.startsWith('file://') &&
        target.url.includes('/out/renderer/index.html') &&
        target.webSocketDebuggerUrl,
    ) ?? null
  )
})

// The window has loaded once its page is complete and React has put the app in #root.
const socket = new WebSocket(page.webSocketDebuggerUrl as string)
await until('connecting to the window', () => {
  if (socket.readyState > WebSocket.OPEN) fail('The DevTools connection closed.')
  return socket.readyState === WebSocket.OPEN ? true : null
})
let nextId = 0
function evaluate(expression: string) {
  const id = ++nextId
  return new Promise<unknown>((done) => {
    const onMessage = (event: MessageEvent) => {
      const message = JSON.parse(String(event.data)) as {
        id?: number
        result?: { result?: { value?: unknown } }
      }
      if (message.id !== id) return
      socket.removeEventListener('message', onMessage)
      done(message.result?.result?.value)
    }
    socket.addEventListener('message', onMessage)
    socket.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true },
      }),
    )
  })
}
const mounted =
  "document.readyState === 'complete' && (document.getElementById('root')?.childElementCount ?? 0) > 0"
await until('showing its window', async () => ((await evaluate(mounted)) === true ? true : null))
socket.close()
console.log(
  `check-launch: Gui's window loaded in ${((Date.now() - started) / 1000).toFixed(1)} s (${page.url}).`,
)

const main = mainProcess()
if (main === null) fail("Couldn't find Gui's main process to quit it.")
const asked = IS_WINDOWS ? 'closing its window' : 'SIGTERM'
if (IS_WINDOWS) execFileSync('taskkill.exe', ['/PID', String(main)])
else process.kill(main, 'SIGTERM')
const how = await Promise.race([exited, sleep(QUIT_WAIT).then(() => null)])
if (how === null) fail(`Gui was still running ${QUIT_WAIT / 1000} seconds after ${asked}.`)
if (how !== 'exit code 0') fail(`Gui ended with ${how} after ${asked}, not exit code 0.`)
// Helpers end a moment after the main process.
for (let i = 0; i < 20 && guiProcesses().length > 0; i++) await sleep(250)
const left = guiProcesses()
if (left.length > 0) fail(`Gui quit but left processes running: ${left.join(', ')}.`)
rmSync(data, { recursive: true, force: true })
console.log('check-launch: Gui quit cleanly.')
