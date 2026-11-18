import { describe, expect, test } from 'bun:test'
import { windowsNames } from '../src/main/executables'
import { childEnv, scrubInheritedEnv } from '../src/main/process'
import { batchCommandLine, cmdArgument, envValue, quoteArgument } from '../src/main/windows-cmd'
import { descendantsIn, leaderIn, parseNetstat, parseParents } from '../src/main/windows-processes'

// The Windows code's pure parts, run on every platform. tests/windows-integration.ts runs the
// real thing on a Windows runner (.github/workflows/windows.yml).

describe('Windows command lookup', () => {
  test('a bare name is tried with each runnable PATHEXT extension, in its order', () => {
    expect(windowsNames('git', '.COM;.EXE;.BAT;.CMD;.VBS;.JS')).toEqual([
      'git.com',
      'git.exe',
      'git.bat',
      'git.cmd',
    ])
    expect(windowsNames('npm', '.CMD;.EXE')).toEqual(['npm.cmd', 'npm.exe'])
  })

  test('a name with a runnable extension is used as it is', () => {
    expect(windowsNames('pwsh.exe', '.COM;.EXE')).toEqual(['pwsh.exe'])
    expect(windowsNames('NPM.CMD', '.COM;.EXE')).toEqual(['NPM.CMD'])
  })

  test('a dot in the name is not an extension', () => {
    expect(windowsNames('node.js-tool', '.EXE')).toEqual(['node.js-tool.exe'])
  })

  test('no PATHEXT falls back to the default', () => {
    expect(windowsNames('git', undefined)).toEqual(['git.com', 'git.exe', 'git.bat', 'git.cmd'])
  })
})

describe('Windows environment names', () => {
  test('match without regard to case', () => {
    const env = childEnv(
      { Path: 'C:\\Windows', electron_run_as_node: '1', ClaudeCode: '1', node_options: '-r x' },
      { PATH: 'C:\\bin' },
      { windows: true, browser: 'none' },
    )
    expect(env).toEqual({ PATH: 'C:\\bin', BROWSER: 'none' })
  })

  test('an extra variable replaces every spelling of it', () => {
    const env = childEnv({ Browser: 'chrome', path: 'a' }, {}, { windows: true, browser: 'none' })
    expect(env).toEqual({ path: 'a', BROWSER: 'none' })
  })

  test('Unix keeps case apart', () => {
    const env = childEnv(
      { Path: 'x', electron_run_as_node: '1' },
      { PATH: 'y' },
      { windows: false },
    )
    expect(env).toEqual({ Path: 'x', electron_run_as_node: '1', PATH: 'y' })
  })

  test('inherited agent markers are dropped in any case on Windows', () => {
    expect(scrubInheritedEnv({ ClaudeCode: '1', claude_code_x: '1', Path: 'p' }, true)).toEqual({
      Path: 'p',
    })
  })

  test('envValue finds a variable in any case', () => {
    expect(envValue({ ComSpec: 'C:\\cmd.exe' }, 'COMSPEC')).toBe('C:\\cmd.exe')
    expect(envValue({}, 'ComSpec')).toBeUndefined()
  })
})

describe('batch file arguments', () => {
  test('quoted as CommandLineToArgvW reads them', () => {
    expect(quoteArgument('a b')).toBe('"a b"')
    expect(quoteArgument('')).toBe('""')
    expect(quoteArgument('say "hi"')).toBe('"say \\"hi\\""')
    expect(quoteArgument('C:\\dir\\')).toBe('"C:\\dir\\\\"')
    expect(quoteArgument('a\\"b')).toBe('"a\\\\\\"b"')
  })

  test("escaped for cmd.exe's two reads", () => {
    expect(cmdArgument('a&b', 1)).toBe('^"a^&b^"')
    expect(cmdArgument('a&b')).toBe('^^^"a^^^&b^^^"')
    expect(cmdArgument('100%', 1)).toBe('^"100^%^"')
    expect(cmdArgument('^(x)|y<z>!', 1)).toBe('^"^^^(x^)^|y^<z^>^!^"')
  })

  test('a line break cannot be passed through cmd.exe', () => {
    expect(() => cmdArgument('a\nb')).toThrow()
  })

  test('the whole command line', () => {
    expect(batchCommandLine('C:\\Program Files\\nodejs\\npm.cmd', ['run', 'dev'])).toEqual([
      '/d',
      '/s',
      '/c',
      '"C:\\Program^ Files\\nodejs\\npm.cmd ^^^"run^^^" ^^^"dev^^^""',
    ])
  })
})

describe('Windows processes and ports', () => {
  const netstat = [
    '',
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1076',
    '  TCP    127.0.0.1:5173         0.0.0.0:0              LISTENING       4242',
    '  TCP    127.0.0.1:5173         127.0.0.1:50123        ESTABLISHED     4242',
    '  TCP    [::]:3000              [::]:0                 LISTENING       4343',
    '  TCP    [::1]:3001             [::]:0                 ABHÖREN         4344',
    '  UDP    0.0.0.0:5353           *:*                                    1',
  ].join('\r\n')

  test('netstat listeners, in any language', () => {
    expect(parseNetstat(netstat)).toEqual([
      { pid: 1076, port: 135, host: '*' },
      { pid: 4242, port: 5173, host: '127.0.0.1' },
      { pid: 4343, port: 3000, host: '[::]' },
      { pid: 4344, port: 3001, host: '[::1]' },
    ])
  })

  const parents = parseParents(
    '0 0\r\n4 0\r\n100 4\r\n200 100\r\n300 200\r\n301 200\r\n400 300\r\n',
  )

  test('a process tree, by parent pid', () => {
    expect([...descendantsIn(parents, 200)].sort()).toEqual([200, 300, 301, 400])
    expect([...descendantsIn(parents, 999)]).toEqual([999])
  })

  test("a process's stand-in group is its ancestor that Gui started", () => {
    expect(leaderIn(parents, 400, 200)).toBe(300)
    expect(leaderIn(parents, 300, 200)).toBe(300)
    expect(leaderIn(parents, 100, 200)).toBe(100)
    // A loop in a stale table ends.
    expect(
      leaderIn(
        new Map([
          [1, 2],
          [2, 1],
        ]),
        1,
        99,
      ),
    ).toBe(1)
  })
})
