import { simpleParser } from 'mailparser'
import { expect, it, vi } from 'vitest'
import type { OutgoingMessage } from '../../mail/mime.ts'
import type { ImapCredentials } from './client.ts'
import { FakeImap } from './fake.ts'
import { ImapProvider } from './provider.ts'

const credentials: ImapCredentials = {
  imap: { host: 'imap.example.com', port: 993, tls: 'implicit', username: 'u', password: 'fake' },
  smtp: { host: 'smtp.example.com', port: 587, tls: 'starttls', username: 'u', password: 'fake' },
  smtpSavesSent: false,
}

const message: OutgoingMessage = {
  from: { address: 'owner@example.com', name: 'Owner' },
  to: [{ address: 'recipient@example.com', name: null }],
  cc: [],
  bcc: [{ address: 'hidden@example.com', name: null }],
  subject: 'Test delivery',
  text: 'Message body',
  messageId: 'delivery@example.com',
}

it('submits a private SMTP envelope and appends the Bcc header only to the Sent copy', async () => {
  const imap = new FakeImap()
  imap.addFolder('Mail/Sent Items', '\\Sent')
  const sendMail = vi
    .fn()
    .mockResolvedValue({ accepted: ['recipient@example.com'], rejected: ['hidden@example.com'] })
  const close = vi.fn()
  const provider = new ImapProvider(
    credentials,
    () => imap.client,
    () => ({ sendMail, close }),
  )
  expect(await provider.send(message)).toMatchObject({
    messageId: message.messageId,
    rejected: ['hidden@example.com'],
    sentCopy: 'appended',
  })
  expect(sendMail).toHaveBeenCalledExactlyOnceWith({
    raw: expect.any(Buffer),
    envelope: { from: 'owner@example.com', to: ['recipient@example.com', 'hidden@example.com'] },
  })
  const submitted = await simpleParser(sendMail.mock.calls[0]?.[0].raw)
  expect(submitted.bcc).toBeUndefined()
  const copy = imap.appended[0]
  expect(copy).toMatchObject({ folder: 'Mail/Sent Items', flags: ['\\Seen'] })
  expect((await simpleParser(copy?.raw ?? Buffer.alloc(0))).headers.get('message-id')).toBe(
    submitted.messageId,
  )
  expect(copy?.raw.toString()).toContain('Bcc: hidden@example.com')
  expect(close).toHaveBeenCalledOnce()
})

it('reports SMTP acceptance when APPEND fails without submitting again', async () => {
  const imap = new FakeImap()
  imap.addFolder('Sent', '\\Sent')
  imap.failAppend = true
  const sendMail = vi.fn().mockResolvedValue({ accepted: ['recipient@example.com'], rejected: [] })
  const provider = new ImapProvider(
    credentials,
    () => imap.client,
    () => ({ sendMail, close() {} }),
  )
  expect((await provider.send(message)).sentCopy).toBe('failed')
  expect(sendMail).toHaveBeenCalledOnce()
})

it('skips APPEND for server-managed Sent copies and never appends after SMTP failure', async () => {
  const imap = vi.fn(() => new FakeImap().client)
  const sendMail = vi
    .fn()
    .mockResolvedValueOnce({ accepted: ['recipient@example.com'], rejected: [] })
    .mockRejectedValueOnce(new Error('test SMTP failure'))
  const smtp = () => ({ sendMail, close() {} })
  const managed = new ImapProvider({ ...credentials, smtpSavesSent: true }, imap, smtp)
  expect((await managed.send(message)).sentCopy).toBe('server-managed')
  await expect(new ImapProvider(credentials, imap, smtp).send(message)).rejects.toThrow(
    'SMTP submission failed',
  )
  expect(imap).not.toHaveBeenCalled()
})

it('checks UIDVALIDITY before a write and refuses MOVE with mailbox-wide expunge', async () => {
  const fake = new FakeImap()
  const move = vi.fn().mockResolvedValue({ path: 'INBOX', destination: 'Archive' })
  const setFlags = vi.fn().mockResolvedValue(true)
  const client = Object.assign(fake.client, { messageMove: move, messageFlagsSet: setFlags })
  const provider = new ImapProvider(credentials, () => client)
  const location = { folder: 'INBOX', uidValidity: '1', uid: 12 }
  await expect(provider.setFlags({ ...location, uidValidity: '2' }, ['\\Seen'])).rejects.toThrow(
    'UIDVALIDITY',
  )
  expect(setFlags).not.toHaveBeenCalled()
  expect(await provider.setFlags(location, ['\\Seen'])).toBe(true)
  expect(setFlags).toHaveBeenCalledWith('12', ['\\Seen'], { uid: true })
  expect(await provider.move(location, 'Archive')).toBe(false)
  expect(move).not.toHaveBeenCalled()
  fake.capabilities.set('MOVE', true)
  expect(await provider.move(location, 'Archive')).toBe(true)
  expect(move).toHaveBeenCalledWith('12', 'Archive', { uid: true })
})
