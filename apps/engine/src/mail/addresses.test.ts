import { describe, expect, it } from 'vitest'
import { cleanMessageId, parseAddressList } from './addresses.ts'

describe('parseAddressList', () => {
  it.each([
    ['a@b.com', [{ name: null, address: 'a@b.com' }]],
    [
      '"Doe, Jane" <j@x.com>, b@y.com',
      [
        { name: 'Doe, Jane', address: 'j@x.com' },
        { name: null, address: 'b@y.com' },
      ],
    ],
    ['Bob (Work) <bob@x.com>', [{ name: 'Bob (Work)', address: 'bob@x.com' }]],
    ['bob@x.com (Bob)', [{ name: 'Bob', address: 'bob@x.com' }]],
    [
      'Team: a@b.c, d@e.f;',
      [
        { name: null, address: 'a@b.c' },
        { name: null, address: 'd@e.f' },
      ],
    ],
    ['undisclosed-recipients:;', []],
    ['', []],
  ])('%s', (input, expected) => {
    expect(parseAddressList(input)).toEqual(expected)
  })
})

describe('cleanMessageId', () => {
  it('strips angle brackets', () => {
    expect(cleanMessageId(' <a@b> ')).toBe('a@b')
    expect(cleanMessageId(null)).toBeNull()
  })
})
