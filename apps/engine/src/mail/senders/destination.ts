import { SCREENED_OUT_LABEL } from '@amc/protocol'
import { transaction } from '../../db/database.ts'
import { toIncomingLabel } from '../../providers/gmail/sync.ts'
import type { GmailApi } from '../../providers/gmail/types.ts'
import { imapMoveSupport } from '../../providers/imap/client.ts'
import { mapFolders, normalUserFolder } from '../../providers/imap/mapping.ts'
import type { ImapAccountSync } from '../../providers/imap/sync.ts'
import type { IncomingLabel, MailStore } from '../store.ts'
import { SenderError } from './actions.ts'

interface Destination {
  provider_id: string | null
  validity: string | null
  mailbox_id: string | null
  state: 'creating' | 'ready' | 'repair'
  error: string | null
}

interface Candidate {
  label: IncomingLabel
  validity?: string
  mailboxId?: string
}

function gmailUserLabel(label: IncomingLabel): boolean {
  return (
    label.kind === 'user' &&
    !/^(?:INBOX|SPAM|TRASH|SENT|DRAFT|UNREAD|STARRED|IMPORTANT)$/i.test(label.providerId)
  )
}

function destination(store: MailStore, account: string) {
  return store.db.prepare('SELECT * FROM screened_destination WHERE account_id = ?').get(account) as
    | Destination
    | undefined
}

function ready(store: MailStore, account: string, candidate: Candidate) {
  const { label, validity, mailboxId } = candidate
  transaction(store.db, () => {
    store.db
      .prepare(`
      INSERT INTO screened_destination VALUES (?, ?, ?, ?, 'ready', NULL)
      ON CONFLICT (account_id) DO UPDATE SET provider_id = excluded.provider_id,
        validity = excluded.validity, mailbox_id = excluded.mailbox_id, state = 'ready', error = NULL
    `)
      .run(account, label.providerId, validity ?? null, mailboxId ?? null)
    store.putLabel(account, label)
    const rows = store.db
      .prepare(`
      UPDATE screening_work SET status = 'pending', error = NULL
      WHERE mutation_id IS NULL AND status = 'failed' AND action_id IN (
        SELECT action_id FROM sender_rule WHERE account_id = ? AND decision = 'block'
      ) RETURNING message_id
    `)
      .all(account)
    for (const { message_id } of rows) {
      if (store.db.prepare('SELECT 1 FROM message WHERE id = ?').get(String(message_id)))
        store.recordChange('message', String(message_id), 'upsert')
    }
  })
  return candidate
}

function repair(store: MailStore, account: string, error: string): never {
  store.db
    .prepare(`
    INSERT INTO screened_destination (account_id, state, error) VALUES (?, 'repair', ?)
    ON CONFLICT (account_id) DO UPDATE SET state = 'repair', error = excluded.error
  `)
    .run(account, error)
  throw new SenderError(error)
}

export async function gmailDestination(
  store: MailStore,
  account: string,
  api: GmailApi,
  allow: () => boolean,
  adopt?: string,
): Promise<Candidate | undefined> {
  const current = destination(store, account)
  const labels = (await api.labels()).map(toIncomingLabel)
  const choices = labels.filter(
    (label) =>
      gmailUserLabel(label) && label.name.toLowerCase() === SCREENED_OUT_LABEL.toLowerCase(),
  )
  if (!allow()) return
  if (adopt) {
    const label = choices.find(({ providerId }) => providerId === adopt)
    if (!label) throw new SenderError('Choose the verified Screened out user Label')
    return ready(store, account, { label })
  }
  if (current?.state === 'ready') {
    const label = labels.find(
      (label) => label.providerId === current.provider_id && gmailUserLabel(label),
    )
    if (!label) return repair(store, account, 'The managed Screened out Label is missing')
    return { label }
  }
  if (current || choices.length)
    return repair(
      store,
      account,
      current?.error ?? 'Verify and adopt the existing Screened out Label',
    )
  if (labels.some(({ name }) => name.toLowerCase() === SCREENED_OUT_LABEL.toLowerCase()))
    return repair(store, account, 'The Screened out name is already in use')
  store.db
    .prepare("INSERT INTO screened_destination (account_id, state) VALUES (?, 'creating')")
    .run(account)
  try {
    const label = toIncomingLabel(await api.createLabel(SCREENED_OUT_LABEL))
    if (gmailUserLabel(label) && label.name === SCREENED_OUT_LABEL)
      return ready(store, account, { label })
  } catch {
    return repair(
      store,
      account,
      'Screened out creation could not be verified. Verify the Label before adopting it.',
    )
  }
  return repair(store, account, 'Screened out creation could not be verified')
}

export async function imapDestination(
  sync: ImapAccountSync,
  allow: () => boolean,
  adopt?: string,
): Promise<Candidate | undefined> {
  const { store, accountId: account, client } = sync
  if (!imapMoveSupport(client).available)
    throw new SenderError('This IMAP Account does not support safe moves')
  const current = destination(store, account)
  const list = await client.list()
  const folders = mapFolders(list)
  const choices = folders.filter(
    ({ label, path }) =>
      label.kind === 'user' &&
      label.name.toLowerCase() === SCREENED_OUT_LABEL.toLowerCase() &&
      normalUserFolder(list, path),
  )
  if (!allow()) return
  const inspect = async (choice: (typeof choices)[number]): Promise<Candidate> => {
    const box = await client.mailboxOpen(choice.path, { readOnly: true })
    return {
      label: choice.label,
      validity: String(box.uidValidity),
      ...(box.mailboxId ? { mailboxId: box.mailboxId } : {}),
    }
  }
  if (adopt) {
    const choice = choices.find(({ label }) => label.providerId === adopt)
    if (!choice) throw new SenderError('Choose the verified Screened out folder')
    const candidate = await inspect(choice)
    return allow() ? ready(store, account, candidate) : undefined
  }
  if (current?.state === 'ready') {
    const same = choices.find(({ label }) => label.providerId === current.provider_id)
    const candidate = same && (await inspect(same))
    if (
      !candidate ||
      candidate.validity !== current.validity ||
      (current.mailbox_id && candidate.mailboxId !== current.mailbox_id)
    )
      return repair(store, account, 'The managed Screened out folder changed or is missing')
    return candidate
  }
  if (current || list.some(({ path }) => path.toLowerCase() === SCREENED_OUT_LABEL.toLowerCase()))
    return repair(
      store,
      account,
      current?.error ?? 'Verify and adopt the existing Screened out folder',
    )
  store.db
    .prepare("INSERT INTO screened_destination (account_id, state) VALUES (?, 'creating')")
    .run(account)
  try {
    const created = await client.mailboxCreate(SCREENED_OUT_LABEL)
    if (
      created.created &&
      created.path === SCREENED_OUT_LABEL &&
      normalUserFolder(await client.list(), created.path)
    ) {
      const candidate = await inspect({
        path: created.path,
        label: {
          providerId: `folder:${encodeURIComponent(created.path)}`,
          name: created.path,
          kind: 'user',
          color: null,
        },
      })
      return ready(store, account, candidate)
    }
  } catch {
    return repair(
      store,
      account,
      'Screened out creation could not be verified. Verify the folder before adopting it.',
    )
  }
  return repair(store, account, 'Screened out creation could not be verified')
}
