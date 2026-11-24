import { expect, it } from 'vitest'
import { type MailLink, mailLink, mailWebLink, parseMailLink, sameMailEngine } from './mail-link.ts'

it.each<MailLink>([
  { kind: 'thread', threadId: "imap:some%40example.test/it's $(printf test); :" },
  { kind: 'draft', draftId: '00000000-0000-4000-8000-000000000001' },
  { kind: 'search', query: 'from:"Änne Beck" subject:"A + B & C?"', accountId: 'a:1' },
  { kind: 'search', query: '"annual budget" after:2026-11-23', accountId: null },
])('round trips $kind links through the native and browser encodings', (target) => {
  const origin = 'https://engine.example.test'
  const url = mailLink(origin, target)
  const web = new URL(mailWebLink('https://engine.example.test', target))
  expect(web.origin + web.pathname + web.search).toBe('https://engine.example.test/open-mail')
  expect(decodeURIComponent(web.hash.slice(1))).toBe(url)
  const parsed = parseMailLink(url)
  expect(parsed).toEqual({ ...target, engineOrigin: origin })
  if (!parsed) throw new Error('Expected engine-bound link')
  expect(sameMailEngine(parsed, origin)).toBe(true)
  expect(sameMailEngine(parsed, 'https://other-engine.example.test')).toBe(false)
})

it.each([
  'https://thread/a',
  'amc://send/anything',
  'amc://draft/id/send?engine=https%3A%2F%2Fengine.example.test',
  'amc://draft/id?engine=https%3A%2F%2Fengine.example.test&send=true',
  'amc://draft/..?engine=https%3A%2F%2Fengine.example.test',
  'amc://draft/id',
  'amc://thread/id/more',
  'amc://thread/id?token=secret',
  'amc://thread/%00?engine=https%3A%2F%2Fengine.example.test',
  'amc://thread/%ff?engine=https%3A%2F%2Fengine.example.test',
  'amc://search?q=',
  'amc://search?q=a&q=b&engine=https%3A%2F%2Fengine.example.test',
  'amc://search?q=hello&accountId=&engine=https%3A%2F%2Fengine.example.test',
  'amc://search?q=hello#there',
  'amc://search?q=hello',
  'amc://search?q=hello&engine=file%3A%2F%2F%2F',
  'amc://search?q=hello&engine=https%3A%2F%2Fuser%40engine.example.test',
])('rejects unsupported or invalid mail links (%s)', (value) => {
  expect(parseMailLink(value)).toBeNull()
})
