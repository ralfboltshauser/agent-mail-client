import { createInterface } from 'node:readline/promises'
import { type ImapAccountAdded, ImapAccountInput } from '@amc/protocol'
import password from '@inquirer/password'
import { authed } from './client.ts'
import type { CliConfig } from './config.ts'

export async function addImapAccount(config: CliConfig): Promise<ImapAccountAdded> {
  const url = new URL(config.engineUrl)
  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname))
  ) {
    throw new Error('IMAP sign-in needs an HTTPS Engine URL or a loopback HTTP URL')
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('IMAP sign-in needs an interactive terminal')
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ask = async (label: string, fallback = '') => {
    const answer = await rl.question(`${label}${fallback ? ` [${fallback}]` : ''}: `)
    return answer.trim() || fallback
  }
  let details: Omit<ImapAccountInput, 'imap' | 'smtp'> & {
    imap: Omit<ImapAccountInput['imap'], 'password'>
    smtp: Omit<ImapAccountInput['smtp'], 'password'>
  }
  let sharedPassword: boolean
  try {
    const address = await ask('Email address')
    const imapHost = await ask('IMAP hostname')
    const imapPort = Number(await ask('IMAP port', '993'))
    const imapTls = await ask(
      'IMAP TLS (implicit/starttls)',
      imapPort === 143 ? 'starttls' : 'implicit',
    )
    const imapUsername = await ask('IMAP username', address)
    const smtpHost = await ask('SMTP hostname')
    const smtpPort = Number(await ask('SMTP port', '587'))
    const smtpTls = await ask(
      'SMTP TLS (implicit/starttls)',
      smtpPort === 465 ? 'implicit' : 'starttls',
    )
    const smtpUsername = await ask('SMTP username', imapUsername)
    sharedPassword = /^y(?:es)?$/i.test(await ask('Use the IMAP password for SMTP? (y/n)', 'y'))
    const smtpSavesSent = /^y(?:es)?$/i.test(
      await ask('Does the SMTP server save a Sent copy? (y/n)', 'n'),
    )
    if (
      (imapTls !== 'implicit' && imapTls !== 'starttls') ||
      (smtpTls !== 'implicit' && smtpTls !== 'starttls')
    ) {
      throw new Error('Choose implicit TLS or STARTTLS for each server')
    }
    details = {
      address,
      imap: { host: imapHost, port: imapPort, tls: imapTls, username: imapUsername },
      smtp: { host: smtpHost, port: smtpPort, tls: smtpTls, username: smtpUsername },
      smtpSavesSent,
    }
  } finally {
    rl.close()
  }

  const imapPassword = await password({ message: 'IMAP password' })
  const smtpPassword = sharedPassword ? imapPassword : await password({ message: 'SMTP password' })
  const account = ImapAccountInput.safeParse({
    ...details,
    imap: { ...details.imap, password: imapPassword },
    smtp: { ...details.smtp, password: smtpPassword },
  })
  if (!account.success) throw new Error('Check the email address, hostnames, ports and logins')
  return authed(config)<ImapAccountAdded>('/v1/accounts/imap', {
    method: 'POST',
    body: account.data,
    redirect: 'error',
  })
}
