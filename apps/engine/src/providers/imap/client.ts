import type { ImapAccountInput } from '@amc/protocol'
import { type CopyResponseObject, ImapFlow } from 'imapflow'
import { parseCopyUid } from 'imapflow/lib/commands/copyuid-parser'
import { encodePath, normalizePath } from 'imapflow/lib/tools'
import nodemailer, { type SMTPTransportOptions } from 'nodemailer'

export type ImapCredentials = Omit<ImapAccountInput, 'address'>

export function imapEndpoint({ host, port, tls, username }: ImapCredentials['imap']): string {
  return JSON.stringify([host.toLowerCase(), port, tls, username])
}

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
  | 'messageCopy'
  | 'messageFlagsAdd'
  | 'messageFlagsRemove'
  | 'messageFlagsSet'
> & {
  uidMove(uid: number, destination: string): Promise<CopyResponseObject | false | undefined>
  uidExpunge(uid: number): Promise<boolean>
}

export function imapMoveSupport(client: Pick<ImapClient, 'capabilities' | 'enabled'>) {
  const native =
    client.capabilities.has('MOVE') ||
    client.enabled.has('IMAP4REV2') ||
    (client.capabilities.has('IMAP4rev2') && !client.capabilities.has('IMAP4rev1'))
  return { native, available: native || client.capabilities.has('UIDPLUS') }
}

// These commands run on a selected mailbox after a public command has ended IDLE.
// ImapFlow's high-level MOVE and delete methods can fall back to mailbox-wide EXPUNGE.
type ImapResponse = Parameters<typeof parseCopyUid>[0]
type ImapCommands = {
  exec(
    command: 'UID MOVE' | 'UID EXPUNGE',
    attributes: { type: 'SEQUENCE' | 'ATOM'; value: string }[],
    options?: { untagged: { OK(response: ImapResponse): Promise<void> } },
  ): Promise<{ response: ImapResponse; next(): void }>
}

function validUid(uid: number): boolean {
  return Number.isInteger(uid) && uid > 0 && uid <= 0xffff_ffff
}

export class ExactUidImapFlow extends ImapFlow {
  async uidMove(uid: number, path: string) {
    if (!this.mailbox || !validUid(uid) || !imapMoveSupport(this).native) return false
    const destination = normalizePath(this, path)
    const result: CopyResponseObject = { path: this.mailbox.path, destination }
    const commands = this as unknown as ImapCommands
    const response = await commands.exec(
      'UID MOVE',
      [
        { type: 'SEQUENCE', value: String(uid) },
        { type: 'ATOM', value: encodePath(this, destination) },
      ],
      {
        untagged: { OK: async (untagged) => parseCopyUid(untagged, result) },
      },
    )
    response.next()
    parseCopyUid(response.response, result)
    return result
  }

  async uidExpunge(uid: number) {
    if (!this.mailbox || !validUid(uid)) return false
    const commands = this as unknown as ImapCommands
    const response = await commands.exec('UID EXPUNGE', [{ type: 'SEQUENCE', value: String(uid) }])
    response.next()
    return true
  }
}

export type ImapClientFactory = (credentials: ImapCredentials['imap']) => ImapClient

export const createImapClient: ImapClientFactory = ({ host, port, tls, username, password }) =>
  new ExactUidImapFlow({
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
