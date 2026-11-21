import { createServer } from 'node:net'
import { createInterface } from 'node:readline'
import { expect, it } from 'vitest'
import { connectImap, ExactUidImapFlow } from './client.ts'

it.each(['MOVE', 'UIDPLUS'])('uses exact UID commands with %s', async (capability) => {
  const commands: string[] = []
  const deleted = new Set([1, 2])
  const server = createServer((socket) => {
    const send = (...lines: string[]) => socket.write(`${lines.join('\r\n')}\r\n`)
    send('* PREAUTH Ready')
    createInterface({ input: socket }).on('line', (line) => {
      const [tag, ...pieces] = line.split(' ')
      const command = pieces.join(' ')
      commands.push(command)
      if (command === 'CAPABILITY') send(`* CAPABILITY IMAP4rev1 ${capability}`, `${tag} OK`)
      else if (command.startsWith('LIST')) send('* LIST () "/" "INBOX"', `${tag} OK`)
      else if (command.startsWith('SELECT')) {
        send(
          '* FLAGS (\\Seen \\Deleted)',
          '* 2 EXISTS',
          '* OK [UIDVALIDITY 1] Stable',
          '* OK [UIDNEXT 3] Next',
          `${tag} OK [READ-WRITE] Selected`,
        )
      } else if (command.startsWith('UID MOVE')) {
        deleted.delete(1)
        send('* OK [COPYUID 7 1 45] Copied', '* 1 EXPUNGE', `${tag} OK Moved`)
      } else if (command.startsWith('UID COPY')) send(`${tag} OK [COPYUID 1 1 45] Copied`)
      else if (command.startsWith('UID STORE')) send('* CAPABILITY IMAP4rev1', `${tag} OK Stored`)
      else if (command === 'UID EXPUNGE 1') {
        deleted.delete(1)
        send('* 1 EXPUNGE', `${tag} OK One expunged`)
      } else send(`${tag} BAD Unexpected command`)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback address')
  const client = new ExactUidImapFlow({
    host: '127.0.0.1',
    port: address.port,
    secure: false,
    doSTARTTLS: false,
    disableAutoIdle: true,
    logger: false,
  })
  try {
    await connectImap(client)
    await client.mailboxOpen('INBOX')
    expect(client.capabilities.has(capability)).toBe(true)
    if (capability === 'MOVE') {
      expect(await client.uidMove(1, 'INBOX/Archive')).toMatchObject({
        uidMap: new Map([[1, 45]]),
        uidValidity: 7n,
      })
      expect(commands.filter((command) => /MOVE|EXPUNGE|COPY/.test(command))).toEqual([
        'UID MOVE 1 INBOX/Archive',
      ])
    } else {
      expect(await client.messageCopy('1', 'INBOX/Archive', { uid: true })).toBeTruthy()
      expect(await client.messageFlagsAdd('1', ['\\Deleted'], { uid: true })).toBe(true)
      expect(client.capabilities.has('UIDPLUS')).toBe(false)
      expect(await client.uidExpunge(1)).toBe(true)
      expect(commands.filter((command) => /MOVE|EXPUNGE|COPY/.test(command))).toEqual([
        'UID COPY 1 INBOX/Archive',
        'UID EXPUNGE 1',
      ])
    }
    expect([...deleted]).toEqual([2])
  } finally {
    client.close()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  }
})
