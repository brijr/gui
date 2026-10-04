import { Problems } from '../src/main/problems'
import { expect, test } from './helpers/test'

// The same error, as the browser reports it and as Vite re-logs it on the dev server. Vite
// only re-logs in some environments (not on CI), so this pairs the two lines directly
// instead of waiting for a dev server to print one.
const MESSAGE = 'TypeError: Gui e2e cannot read the list'

test('an error Vite re-logs on the dev server counts once, as the browser reported it', () => {
  const problems = new Problems()
  problems.addConsole('error', `Uncaught ${MESSAGE}`, 'http://localhost:5173/src/main.tsx:4')
  problems.addServerLine(`9:41:07 AM [vite] (client) [Unhandled error] ${MESSAGE}`)
  problems.addServerLine(`[vite] (client) [Unhandled error] ${MESSAGE}`)
  expect(problems.list().map((problem) => problem.source)).toEqual(['console'])

  // A different error from the dev server still counts on its own.
  problems.addServerLine('Error: Failed to resolve import "./missing" from "src/App.tsx"')
  expect(problems.list().map((problem) => problem.source)).toEqual(['console', 'server'])
  problems.dispose()
})
