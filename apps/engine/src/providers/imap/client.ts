import type { ImapAccountInput } from '@amc/protocol'
import { ImapFlow } from 'imapflow'
import nodemailer, { type SMTPTransportOptions } from 'nodemailer'

export type ImapCredentials = Omit<ImapAccountInput, 'address'>

export type ImapClient = Pick<
  ImapFlow,
  | 'connect'
  | 'close'
  | 'list'
  | 'mailboxOpen'
  | 'search'
  | 'fetch'
  | 'idle'
  | 'download'
  | 'capabilities'
  | 'enabled'
  | 'usable'
  | 'mailbox'
  | 'on'
  | 'off'
  | 'append'
  | 'messageMove'
  | 'messageFlagsSet'
>

export type ImapClientFactory = (credentials: ImapCredentials['imap']) => ImapClient

export const createImapClient: ImapClientFactory = ({ host, port, tls, username, password }) =>
  new ImapFlow({
    host,
    port,
    secure: tls === 'implicit',
    doSTARTTLS: tls === 'starttls',
    auth: { user: username, pass: password },
    logger: false,
    qresync: true,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
  })

export function createSmtpClient({ host, port, tls, username, password }: ImapCredentials['smtp']) {
  const options: SMTPTransportOptions = {
    host,
    port,
    secure: tls === 'implicit',
    requireTLS: tls === 'starttls',
    auth: { user: username, pass: password },
    logger: false,
    debug: false,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 60_000,
  }
  return nodemailer.createTransport(options)
}

export class ImapAuthError extends Error {
  constructor() {
    super('IMAP authentication failed. Sign in to this Account again.')
  }
}

export async function connectImap(client: ImapClient): Promise<void> {
  // ImapFlow emits socket errors even when the command also rejects. Do not forward provider
  // errors to the Engine logger: server response strings can contain credentials or mail data.
  client.on('error', () => {})
  try {
    await client.connect()
  } catch (error) {
    if (
      typeof error === 'object' &&
      error &&
      'authenticationFailed' in error &&
      error.authenticationFailed
    ) {
      throw new ImapAuthError()
    }
    throw new Error('Could not connect to the IMAP server over TLS')
  }
}

export async function verifyImapAccount(credentials: ImapCredentials): Promise<void> {
  const imap = createImapClient(credentials.imap)
  try {
    await connectImap(imap)
    await imap.mailboxOpen('INBOX', { readOnly: true })
  } catch {
    throw new Error('Could not sign in to IMAP and open INBOX over TLS')
  } finally {
    imap.close()
  }

  const smtp = createSmtpClient(credentials.smtp)
  try {
    await smtp.verify()
  } catch {
    throw new Error('Could not sign in to SMTP over TLS')
  } finally {
    smtp.close()
  }
}
