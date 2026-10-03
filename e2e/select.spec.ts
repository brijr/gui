import { FIXTURES, lineOf } from './helpers/fixtures'
import { expect, test } from './helpers/test'

// The agent edits whatever file and line this resolves to, so "close" is wrong: the
// source must be the exact file and line of the element's JSX, not an approximation.
for (const fixture of FIXTURES) {
  test(`${fixture.name}: picking resolves the exact source and owners`, async ({ launch }) => {
    const session = await launch({ fixture: fixture.name })
    await session.waitForPreview()
    const selection = await session.pickElement(fixture.selector)
    await session.shot('selected')

    expect(selection.tag).toBe('button')
    expect(selection.text).toContain(fixture.text)
    expect(selection.url).toMatch(/^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+/)
    expect(selection.componentStack).toEqual(fixture.components)
    expect(selection.source).toMatchObject({
      file: fixture.file,
      line: lineOf(session.fixture.root, fixture.file, fixture.marker),
      approximate: false,
    })
    // Context the agent receives alongside the source.
    expect(selection.screenshot).toMatch(/^data:image\/png;base64,/)
    expect(Object.keys(selection.styles)).toContain('background-color')
  })
}
