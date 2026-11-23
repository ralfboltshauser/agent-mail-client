import { FILTERED_LABEL, SCREENED_OUT_LABEL } from '@amc/protocol'
import { transaction } from '../../db/database.ts'
import { GmailHttpError } from '../../providers/gmail/http.ts'
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
  const listLabels = async () => {
    try {
      return (await api.labels()).map(toIncomingLabel)
    } catch (error) {
      if (!filtered) throw error
      throw new SenderError(`Could not verify the ${name} Label with Gmail. Retry Filter out.`)
    }
  }
  const labels = await listLabels()
  const matches = (label: IncomingLabel) =>
    gmailUserLabel(label) && label.name.toLowerCase() === name.toLowerCase()
  const choices = labels.filter(matches)
  const unverified = `${name} creation could not be verified. Retry when the Label is available.`
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
  const recover = (listed: IncomingLabel[], expectedId?: string) => {
    const named = listed.filter((label) => label.name.toLowerCase() === name.toLowerCase())
    const label = named[0]
    if (!label) return
    if (named.length !== 1)
      return repair(
        store,
        account,
        `Multiple Labels match ${name}. Resolve the name conflict and retry.`,
        table,
      )
    if (label.name !== name || !label.providerId || !gmailUserLabel(label))
      return repair(
        store,
        account,
        `The ${name} name is in use. An exact ${name} user Label is required.`,
        table,
      )
    if (expectedId && label.providerId !== expectedId) throw new SenderError(unverified)
    return ready(store, account, { label }, filtered)
  }
  if (filtered) {
    const expectedId = current?.state === 'creating' ? current.provider_id : null
    const recovered = recover(labels, expectedId ?? undefined)
    if (recovered) return recovered
    if (expectedId) throw new SenderError(unverified)
  } else if (current?.state === 'creating' && current.provider_id) {
    const label = choices.find(({ providerId }) => providerId === current.provider_id)
    if (label) return ready(store, account, { label }, filtered)
    if (!choices.length) throw new SenderError(unverified)
  }
  if (choices.length)
    return repair(store, account, `Verify and adopt the existing ${name} Label`, table)
  if (labels.some(({ name: existing }) => existing.toLowerCase() === name.toLowerCase()))
    return repair(store, account, `The ${name} name is already in use`, table)
  if (current && (!filtered || current.provider_id))
    return repair(store, account, current.error ?? unverified, table)

  store.db
    .prepare(`
      INSERT INTO ${table} (account_id, state) VALUES (?, 'creating')
      ON CONFLICT (account_id) DO UPDATE SET state = 'creating', error = NULL
    `)
    .run(account)
  let providerId: string | undefined
  try {
    providerId = (await api.createLabel(name))?.id
  } catch (error) {
    if (filtered && error instanceof GmailHttpError && error.status === 409) {
      const listed = await listLabels()
      if (!allow()) return
      const recovered = recover(listed)
      if (recovered) return recovered
    }
    return repair(store, account, unverified, table)
  }
  if (!providerId) return repair(store, account, unverified, table)

  // Gmail can return a sparse create response. Persist its ID before checking the full label.
  store.db
    .prepare(`UPDATE ${table} SET provider_id = ? WHERE account_id = ?`)
    .run(providerId, account)
  const listed = await listLabels()
  if (!allow()) return
  if (filtered) {
    const verified = recover(listed, providerId)
    if (verified) return verified
    throw new SenderError(unverified)
  }
  const label = listed.find((label) => label.providerId === providerId && matches(label))
  if (!label) throw new SenderError(unverified)
  return ready(store, account, { label }, filtered)
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
  const unavailable = `Could not verify the ${name} folder with IMAP. Retry Filter out.`
  const listFolders = async () => {
    try {
      return await client.list()
    } catch (error) {
      if (!filtered) throw error
      throw new SenderError(unavailable)
    }
  }
  const list = await listFolders()
  const folders = mapFolders(list)
  const choices = folders.filter(
    ({ label, path }) =>
      label.kind === 'user' &&
      label.name.toLowerCase() === name.toLowerCase() &&
      normalUserFolder(list, path),
  )
  if (!allow()) return
  const inspect = async (choice: (typeof choices)[number]): Promise<Candidate> => {
    try {
      const box = await client.mailboxOpen(choice.path, { readOnly: true })
      return {
        label: choice.label,
        validity: String(box.uidValidity),
        ...(box.mailboxId ? { mailboxId: box.mailboxId } : {}),
      }
    } catch (error) {
      if (!filtered) throw error
      throw new SenderError(unavailable)
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
  if (filtered && !current?.provider_id) {
    const recover = async (listed: typeof list) => {
      if (!allow()) return
      const named = listed.filter(({ path }) => path.toLowerCase() === name.toLowerCase())
      if (!named.length) return
      if (named.length !== 1)
        return repair(
          store,
          account,
          `Multiple folders match ${name}. Resolve the name conflict and retry.`,
          table,
        )
      const choice = mapFolders(named).find(
        ({ path, label }) =>
          path === name && label.kind === 'user' && normalUserFolder(named, path),
      )
      if (!choice)
        return repair(
          store,
          account,
          `The ${name} name is in use. An exact selectable ${name} user folder is required.`,
          table,
        )
      const candidate = await inspect(choice)
      return allow() ? ready(store, account, candidate, filtered) : undefined
    }
    const existing = await recover(list)
    if (existing || !allow()) return existing

    store.db
      .prepare(`
        INSERT INTO ${table} (account_id, state) VALUES (?, 'creating')
        ON CONFLICT (account_id) DO UPDATE SET state = 'creating', error = NULL
      `)
      .run(account)
    try {
      await client.mailboxCreate(name)
    } catch {
      // CREATE can fail if the folder was created after the initial LIST.
    }
    const created = await recover(await listFolders())
    if (created || !allow()) return created
    return repair(
      store,
      account,
      `${name} creation could not be verified. Retry when the folder is available.`,
      table,
    )
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
    // The caller receives and persists the repair-required outcome for an unverified folder.
    return repair(
      store,
      account,
      `${name} creation could not be verified. Verify the folder before adopting it.`,
      table,
    )
  }
  return repair(store, account, `${name} creation could not be verified`, table)
}
