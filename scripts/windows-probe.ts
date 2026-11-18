// Temporary: measures Windows tools on the CI runner to pick mechanisms. Removed before merge.
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function time(label: string, file: string, args: string[], show = 400) {
  const runs: number[] = []
  let out = ''
  for (let i = 0; i < 3; i++) {
    const start = performance.now()
    try {
      out = execFileSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
    } catch (error) {
      out = `ERROR ${(error as Error).message}`
    }
    runs.push(Math.round(performance.now() - start))
  }
  console.log(`\n## ${label}: ${runs.join(' / ')} ms`)
  console.log(out.slice(0, show))
}

console.log('platform', process.platform, process.arch, process.version)
for (const key of Object.keys(process.env).sort())
  if (/^(path|pathext|comspec|shell|systemroot|userprofile|homedrive|homepath|localappdata|appdata|psmodulepath|processor_architecture)$/i.test(key))
    console.log(key, '=', process.env[key])

const sys = process.env.SystemRoot ?? 'C:\\Windows'
const ps = `${sys}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
time('netstat -ano -p TCP', `${sys}\\System32\\netstat.exe`, ['-ano', '-p', 'TCP'])
time('netstat -ano -p TCPv6', `${sys}\\System32\\netstat.exe`, ['-ano', '-p', 'TCPv6'])
time('tasklist csv', `${sys}\\System32\\tasklist.exe`, ['/FO', 'CSV', '/NH'])
time('powershell CIM pid/ppid', ps, [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
  'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.ParentProcessId)" }',
])
time('powershell Get-Process parent (PS5 has no .Parent)', ps, [
  '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '[Diagnostics.Process]::GetProcesses().Count',
])
time('powershell noop', ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '1'])
time('pwsh noop', 'pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '1'])
time('wmic', 'wmic.exe', ['process', 'get', 'ProcessId,ParentProcessId'], 200)
time('tar --version', `${sys}\\System32\\tar.exe`, ['--version'])
time('where git', `${sys}\\System32\\where.exe`, ['git', 'bash', 'sh', 'node', 'npm', 'pwsh', 'claude', 'codex'])
time('cmd ver', process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'ver'])

// tar on .tgz and .zip
const dir = mkdtempSync(join(tmpdir(), 'probe-'))
writeFileSync(join(dir, 'a.txt'), 'hello')
execFileSync(`${sys}\\System32\\tar.exe`, ['-czf', join(dir, 'a.tgz'), '-C', dir, 'a.txt'])
execFileSync(`${sys}\\System32\\tar.exe`, ['-a', '-cf', join(dir, 'a.zip'), '-C', dir, 'a.txt'])
time('tar -xzf tgz', `${sys}\\System32\\tar.exe`, ['-xzf', join(dir, 'a.tgz'), '-C', dir])
time('tar -xf zip', `${sys}\\System32\\tar.exe`, ['-xf', join(dir, 'a.zip'), '-C', dir])

// spawning a .cmd without a shell
writeFileSync(join(dir, 'echo.cmd'), '@echo off\r\necho args: %*\r\n')
try {
  console.log(execFileSync(join(dir, 'echo.cmd'), ['a b'], { encoding: 'utf8' }))
} catch (error) {
  console.log('\n## .cmd without shell:', (error as Error).message)
}

// taskkill tree timing: node parent with a node child
const parent = spawn(process.execPath, ['-e', `require('child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'ignore'}); setInterval(()=>{},1000)`], { stdio: 'ignore', windowsHide: true })
await new Promise((r) => setTimeout(r, 1500))
time('taskkill /T /F', `${sys}\\System32\\taskkill.exe`, ['/PID', String(parent.pid), '/T', '/F'])
console.log('process.kill(-pid) on windows:')
try {
  process.kill(-12345, 'SIGTERM')
} catch (error) {
  console.log((error as Error).message)
}
