import { expect, it } from 'vitest'
import { type MailLink, mailLink, mailWebLink, parseMailLink } from './mail-link.ts'

it.each<MailLink>([
  { kind: 'thread', threadId: "imap:some%40example.test/it's $(printf test); :" },
  { kind: 'search', query: 'from:"Änne Beck" subject:"A + B & C?"', accountId: 'a:1' },
  { kind: 'search', query: '"annual budget" after:2026-11-23', accountId: null },
])('round trips $kind links through the native and browser encodings', (target) => {
  const url = mailLink(target)
  const web = new URL(mailWebLink('https://engine.example.test', target))
  expect(web.origin + web.pathname + web.search).toBe('https://engine.example.test/open-mail')
  expect(decodeURIComponent(web.hash.slice(1))).toBe(url)
  expect(parseMailLink(url)).toEqual(target)
})

it.each([
  'https://thread/a',
  'amc://send/anything',
  'amc://thread/id/more',
  'amc://thread/id?token=secret',
  'amc://thread/%00',
  'amc://thread/%ff',
  'amc://search?q=',
  'amc://search?q=a&q=b',
  'amc://search?q=hello&accountId=',
  'amc://search?q=hello#there',
])('rejects unsupported or invalid mail links (%s)', (value) => {
  expect(parseMailLink(value)).toBeNull()
})
