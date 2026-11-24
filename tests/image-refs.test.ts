import { expect, test } from 'bun:test'
import { dropImageRef, imageRefParts, writtenText } from '../src/shared/image-refs'

test('a draft of references alone sends no text', () => {
  expect(writtenText(' [Image 1] [Image 2]\n')).toBe('')
  expect(writtenText(' Compare [Image 1] with [Image 2] ')).toBe('Compare [Image 1] with [Image 2]')
})

test('removing an image drops its reference and renumbers the later ones', () => {
  expect(dropImageRef('Compare [Image 1] with [Image 2] and [Image 3]', 2)).toBe(
    'Compare [Image 1] with and [Image 2]',
  )
  expect(dropImageRef('[Image 1] looks off', 1)).toBe('looks off')
  expect(dropImageRef('Like this [Image 1]', 1)).toBe('Like this')
  expect(dropImageRef('A [Image 2]\nB', 1)).toBe('A [Image 1]\nB')
})

test('a message splits into text and image numbers', () => {
  expect(imageRefParts('Is [Image 1] darker than [Image 2]?')).toEqual([
    'Is ',
    1,
    ' darker than ',
    2,
    '?',
  ])
  expect(imageRefParts('[Image 3]')).toEqual([3])
  expect(imageRefParts('No images')).toEqual(['No images'])
})
