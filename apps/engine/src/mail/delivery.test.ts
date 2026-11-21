import { simpleParser } from 'mailparser'
import { expect, it, vi } from 'vitest'
import { GmailHttpApi } from '../providers/gmail/http.ts'
import { AccessTokens, GMAIL_SCOPE } from '../providers/gmail/oauth.ts'
import { QuotaLimiter } from '../providers/gmail/ratelimit.ts'
import type { ImapCredentials } from '../providers/imap/client.ts'
import { FakeImap } from '../providers/imap/fake.ts'
import { ImapProvider } from '../providers/imap/provider.ts'
import { gmailDelivery, imapDelivery, imapDraftMirror } from './delivery.ts'
import type { FrozenMessage } from './outbox.ts'

const message: FrozenMessage = {
  accountId: 'account',
  draftId: 'draft',
  revision: 1,
  threadId: null,
  providerDraftId: null,
  from: { address: 'owner@example.test', name: null },
  to: [{ address: 'recipient@example.test', name: null }],
  cc: [],
  bcc: [],
  subject: 'Synthetic delivery',
  text: 'Hello',
  attachments: [],
}
const rfcId = 'delivery@example.test'
const credentials: ImapCredentials = {
  imap: { host: 'localhost', port: 993, tls: 'implicit', username: 'u', password: 'fake' },
  smtp: { host: 'localhost', port: 587, tls: 'starttls', username: 'u', password: 'fake' },
  smtpSavesSent: true,
}

it('surfaces send 5xx after one Gmail POST and gives the outbox the 429 Retry-After', async () => {
  const tokens = new AccessTokens(
    { clientId: 'fake', clientSecret: 'fake' },
    { refreshToken: 'fake', scope: GMAIL_SCOPE },
  )
  tokens.seed('fake', Date.now() + 600_000)
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ error: { message: 'Backend error' } }, { status: 503 }))
    .mockResolvedValueOnce(
      Response.json(
        { error: { message: 'Rate limited' } },
        { status: 429, headers: { 'Retry-After': '17' } },
      ),
    )
  const limiter = new QuotaLimiter()
  vi.spyOn(limiter, 'take').mockResolvedValue()
  const api = new GmailHttpApi(tokens, fetch, { limiter })
  const provider = gmailDelivery(api)
  await expect(provider.send(message, rfcId)).rejects.toThrow('503')
  expect(fetch).toHaveBeenCalledOnce()
  await expect(provider.send(message, rfcId)).resolves.toEqual({ kind: 'retry', afterMs: 17_000 })
  expect(fetch).toHaveBeenCalledTimes(2)
  for (const [url, init] of fetch.mock.calls) {
    expect(String(url)).toMatch(/\/messages\/send$/)
    expect(init?.method).toBe('POST')
    const body = JSON.parse(String(init?.body))
    expect((await simpleParser(Buffer.from(body.raw, 'base64url'))).messageId).toBe(`<${rfcId}>`)
  }
})

it('confirms a lost SMTP response only after an exact Sent Message-ID match', async () => {
  const imap = new FakeImap()
  imap.addFolder('Sent', '\\Sent')
  const sendMail = vi.fn().mockImplementation(async ({ raw }) => {
    await imap.append('Sent', raw, ['\\Seen'])
    throw new Error('Lost final SMTP reply')
  })
  const provider = imapDelivery(
    new ImapProvider(
      credentials,
      () => imap.client,
      () => ({ sendMail, close() {} }),
    ),
  )
  await expect(provider.send(message, rfcId)).rejects.toThrow('could not be confirmed')
  expect(await provider.find(message, 'delivery@example')).toBeNull()
  expect(await provider.find(message, rfcId)).toMatchObject({ providerId: 'Sent:1:1' })
  expect(sendMail).toHaveBeenCalledOnce()
})

it('mirrors an IMAP draft and removes only the recorded UID under UIDPLUS', async () => {
  const imap = new FakeImap()
  imap.addFolder('Drafts', '\\Drafts')
  const mirror = imapDraftMirror(new ImapProvider(credentials, () => imap.client))
  const raw = 'Message-ID: <draft@example.test>\r\n\r\nDraft'
  await expect(mirror.saveDraft({ raw })).rejects.toThrow('UID EXPUNGE')
  expect(imap.appended).toHaveLength(0)
  imap.capabilities.set('UIDPLUS', true)
  const saved = await mirror.saveDraft({ raw })
  expect(imap.folder('Drafts').messages.size).toBe(1)
  await mirror.deleteDraft(saved.id)
  expect(imap.folder('Drafts').messages.size).toBe(0)
})

it('reports definitive SMTP failures and keeps a lost DATA reply in reconciliation', async () => {
  const imap = new FakeImap()
  imap.addFolder('Sent', '\\Sent')
  let sent: Buffer | undefined
  const sendMail = vi
    .fn()
    .mockRejectedValueOnce(
      Object.assign(new Error('Private auth response'), {
        command: 'AUTH PLAIN',
        code: 'EAUTH',
        responseCode: 535,
      }),
    )
    .mockRejectedValueOnce(
      Object.assign(new Error('Private recipient response'), {
        command: 'RCPT TO',
        code: 'EENVELOPE',
        responseCode: 550,
      }),
    )
    .mockRejectedValueOnce(
      Object.assign(new Error('Private DATA response'), {
        command: 'DATA',
        code: 'EMESSAGE',
        responseCode: 554,
      }),
    )
    .mockImplementationOnce(async ({ raw }) => {
      sent = raw
      throw Object.assign(new Error('Lost DATA reply'), { command: 'CONN', code: 'ECONNECTION' })
    })
  const delivery = imapDelivery(
    new ImapProvider(
      credentials,
      () => imap.client,
      () => ({ sendMail, close() {} }),
    ),
  )
  await expect(delivery.send(message, rfcId)).resolves.toEqual({
    kind: 'failed',
    detail: 'SMTP authentication failed (SMTP 535). Sign in to this Account again.',
  })
  await expect(delivery.send(message, rfcId)).resolves.toEqual({
    kind: 'failed',
    detail: 'SMTP rejected all recipients (SMTP 550).',
  })
  await expect(delivery.send(message, rfcId)).resolves.toEqual({
    kind: 'failed',
    detail: 'SMTP rejected the message (SMTP 554).',
  })
  await expect(delivery.send(message, rfcId)).rejects.toThrow('could not be confirmed')
  await expect(delivery.find(message, rfcId)).resolves.toBeNull()
  if (!sent) throw new Error('No message submitted')
  await imap.append('Sent', sent, ['\\Seen'])
  await expect(delivery.find(message, rfcId)).resolves.toMatchObject({ providerId: 'Sent:1:1' })
  expect(sendMail).toHaveBeenCalledTimes(4)
})

it('reports both partial SMTP rejection and failed APPEND without losing the accepted receipt', async () => {
  const imap = new FakeImap()
  imap.addFolder('Sent', '\\Sent')
  imap.failAppend = true
  const sendMail = vi.fn().mockResolvedValue({
    accepted: ['recipient@example.test'],
    rejected: ['second@example.test'],
  })
  const delivery = imapDelivery(
    new ImapProvider(
      { ...credentials, smtpSavesSent: false },
      () => imap.client,
      () => ({ sendMail, close() {} }),
    ),
  )
  await expect(
    delivery.send(
      {
        ...message,
        cc: [{ address: 'second@example.test', name: null }],
      },
      rfcId,
    ),
  ).resolves.toMatchObject({
    kind: 'accepted',
    receipt: {
      detail:
        '1 recipient(s) were rejected by SMTP. SMTP accepted the message. The Sent copy could not be saved.',
    },
  })
  expect(sendMail).toHaveBeenCalledOnce()
})

it('closes an IMAP connection when the Sent lookup stalls', async () => {
  const imap = new FakeImap()
  imap.addFolder('Sent', '\\Sent')
  vi.spyOn(imap, 'search').mockImplementation(() => new Promise(() => {}))
  vi.useFakeTimers()
  try {
    const provider = new ImapProvider(credentials, () => imap.client)
    const lookup = expect(provider.findSent(rfcId)).rejects.toThrow('Sent lookup timed out')
    await vi.advanceTimersByTimeAsync(5000)
    await lookup
    expect(imap.usable).toBe(false)
  } finally {
    vi.useRealTimers()
  }
})
