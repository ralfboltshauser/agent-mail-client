import { FILTERED_LABEL, SCREENED_OUT_LABEL } from '@amc/protocol'
import { transaction } from '../../db/database.ts'
import { toIncomingLabel } from '../../providers/gmail/sync.ts'
import type { GmailApi } from '../../providers/gmail/types.ts'
import { imapMoveSupport } from '../../providers/imap/client.ts'
import { mapFolders, normalUserFolder } from '../../providers/imap/mapping.ts'
import type { ImapAccountSync } from '../../providers/imap/sync.ts'
import type { IncomingLabel, MailStore } from '../store.ts'
import { SenderError } from './actions.ts'

export function managedDestination(filtered: boolean) {
  return filtered
    ? { table: 'filtered_destination', name: FILTERED_LABEL }
    : { table: 'screened_destination', name: SCREENED_OUT_LABEL }
}

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

function destination(store: MailStore, account: string, table: string) {
  return store.db.prepare(`SELECT * FROM ${table} WHERE account_id = ?`).get(account) as
    | Destination
    | undefined
}

function ready(store: MailStore, account: string, candidate: Candidate, filtered: boolean) {
  const { table } = managedDestination(filtered)
  const { label, validity, mailboxId } = candidate
  transaction(store.db, () => {
    store.db
      .prepare(`
      INSERT INTO ${table} VALUES (?, ?, ?, ?, 'ready', NULL)
      ON CONFLICT (account_id) DO UPDATE SET provider_id = excluded.provider_id,
        validity = excluded.validity, mailbox_id = excluded.mailbox_id, state = 'ready', error = NULL
    `)
      .run(account, label.providerId, validity ?? null, mailboxId ?? null)
    store.putLabel(account, label)
    const active = filtered
      ? "SELECT id FROM owner_action WHERE account_id = ? AND kind = 'filter:review' AND undo_requested_at IS NULL"
      : "SELECT action_id FROM sender_rule WHERE account_id = ? AND decision = 'block'"
    const rows = store.db
      .prepare(`
      UPDATE screening_work SET status = 'pending', error = NULL
      WHERE mutation_id IS NULL AND status = 'failed' AND action_id IN (${active})
      RETURNING message_id
    `)
      .all(account)
    for (const { message_id } of rows) {
      if (store.db.prepare('SELECT 1 FROM message WHERE id = ?').get(String(message_id)))
        store.recordChange('message', String(message_id), 'upsert')
    }
  })
  return candidate
}

function repair(store: MailStore, account: string, error: string, table: string): never {
  store.db
    .prepare(`
    INSERT INTO ${table} (account_id, state, error) VALUES (?, 'repair', ?)
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
  filtered = false,
): Promise<Candidate | undefined> {
  const { table, name } = managedDestination(filtered)
  const current = destination(store, account, table)
  const labels = (await api.labels()).map(toIncomingLabel)
  const choices = labels.filter(
    (label) => gmailUserLabel(label) && label.name.toLowerCase() === name.toLowerCase(),
  )
  if (!allow()) return
  if (adopt) {
    const label = choices.find(({ providerId }) => providerId === adopt)
    if (!label) throw new SenderError(`Choose the verified ${name} user Label`)
    return ready(store, account, { label }, filtered)
  }
  if (current?.state === 'ready') {
    const label = labels.find(
      (label) => label.providerId === current.provider_id && gmailUserLabel(label),
    )
    if (!label) return repair(store, account, `The managed ${name} Label is missing`, table)
    return { label }
  }
  if (current || choices.length)
    return repair(
      store,
      account,
      current?.error ?? `Verify and adopt the existing ${name} Label`,
      table,
    )
  if (labels.some(({ name: existing }) => existing.toLowerCase() === name.toLowerCase()))
    return repair(store, account, `The ${name} name is already in use`, table)
  store.db.prepare(`INSERT INTO ${table} (account_id, state) VALUES (?, 'creating')`).run(account)
  try {
    const label = toIncomingLabel(await api.createLabel(name))
    if (gmailUserLabel(label) && label.name === name)
      return ready(store, account, { label }, filtered)
  } catch {
    return repair(
      store,
      account,
      `${name} creation could not be verified. Verify the Label before adopting it.`,
      table,
    )
  }
  return repair(store, account, `${name} creation could not be verified`, table)
}

export async function imapDestination(
  sync: ImapAccountSync,
  allow: () => boolean,
  adopt?: string,
  filtered = false,
): Promise<Candidate | undefined> {
  const { store, accountId: account, client } = sync
  if (!imapMoveSupport(client).available)
    throw new SenderError('This IMAP Account does not support safe moves')
  const { table, name } = managedDestination(filtered)
  const current = destination(store, account, table)
  const list = await client.list()
  const folders = mapFolders(list)
  const choices = folders.filter(
    ({ label, path }) =>
      label.kind === 'user' &&
      label.name.toLowerCase() === name.toLowerCase() &&
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
    if (!choice) throw new SenderError(`Choose the verified ${name} folder`)
    const candidate = await inspect(choice)
    return allow() ? ready(store, account, candidate, filtered) : undefined
  }
  if (current?.state === 'ready') {
    const same = choices.find(({ label }) => label.providerId === current.provider_id)
    const candidate = same && (await inspect(same))
    if (
      !candidate ||
      candidate.validity !== current.validity ||
      (current.mailbox_id && candidate.mailboxId !== current.mailbox_id)
    )
      return repair(store, account, `The managed ${name} folder changed or is missing`, table)
    return candidate
  }
  if (current || list.some(({ path }) => path.toLowerCase() === name.toLowerCase()))
    return repair(
      store,
      account,
      current?.error ?? `Verify and adopt the existing ${name} folder`,
      table,
    )
  store.db.prepare(`INSERT INTO ${table} (account_id, state) VALUES (?, 'creating')`).run(account)
  try {
    const created = await client.mailboxCreate(name)
    if (
      created.created &&
      created.path === name &&
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
      return ready(store, account, candidate, filtered)
    }
  } catch {
    return repair(
      store,
      account,
      `${name} creation could not be verified. Verify the folder before adopting it.`,
      table,
    )
  }
  return repair(store, account, `${name} creation could not be verified`, table)
}
