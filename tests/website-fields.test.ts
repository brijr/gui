import { expect, test } from 'bun:test'
import { SENSITIVE_AUTOCOMPLETE, SENSITIVE_NAME } from '../src/main/preview-interactions'

test('password, one-time code and payment fields are told apart by their autocomplete token', () => {
  for (const token of [
    'current-password',
    'new-password',
    'one-time-code',
    'cc-number',
    'cc-csc',
    'cc-exp',
    'billing cc-name',
  ])
    expect(SENSITIVE_AUTOCOMPLETE.test(token)).toBe(true)
  for (const token of ['email', 'username', 'search', 'name', 'off', ''])
    expect(SENSITIVE_AUTOCOMPLETE.test(token)).toBe(false)
})

test('and by what they are called, for forms without tokens', () => {
  for (const name of [
    'password',
    'Passcode',
    'Card number',
    'cardnumber',
    'CVC',
    'cvv2',
    'Security code',
    'Expiry date',
    'IBAN',
    'Routing number',
    'Account number',
    'SSN',
    'PIN',
  ])
    expect(SENSITIVE_NAME.test(name)).toBe(true)
  for (const name of [
    'Search',
    'Email',
    'Full name',
    'Company',
    'Workspace URL',
    'Pinned',
    'Spinner',
  ])
    expect(SENSITIVE_NAME.test(name)).toBe(false)
})
