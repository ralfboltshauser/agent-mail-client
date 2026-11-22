import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import type { LabelPatch } from '@amc/protocol'
import { transaction } from '../../db/database.ts'
import type { Logger } from '../../log.ts'
import { managedDestination } from '../../mail/senders/destination.ts'
import { senderMailbox } from '../../mail/senders/identity.ts'
import { normalizeSender } from '../../mail/senders/index.ts'
import { labelId } from '../../mail/store.ts'
import { type ImapClient, imapMoveSupport } from './client.ts'
import type { MessageLocation } from './locations.ts'
import { type Folder, mapFolders, messageFlags, normalUserFolder } from './mapping.ts'
import type { ImapAccountSync } from './sync.ts'

export type ImapMutationRunner = (
  accountId: string,
  work: (sync: ImapAccountSync) => Promise<void>,
) => Promise<boolean>

export interface ImapChange {
  message_id: string
  before: Record<string, boolean | null>
  after: LabelPatch
  revisions?: Record<string, string>
  moveFrom?: Pick<MessageLocation, 'path_key' | 'validity'>
}

interface Move {
  source: MessageLocation
  destination: Folder
  flags: ReturnType<typeof messageFlags>
  lookup?: { messageId: string; validity: string; firstNewUid: number }
}

interface Pending {
  change: ImapChange
  move?: Move
  copied?: { uid?: number; validity?: string }
}

export interface ImapJournalEntry {
  applied: ImapChange[]
  superseded: ImapChange[]
  failed: ImapChange[]
  uncertain?: ImapChange[]
  error?: string
  pending?: Pending
}

export function imapLocationRevision(
  location: Pick<MessageLocation, 'path_key' | 'validity' | 'uid'>,
): string {
  return JSON.stringify([location.path_key, location.validity, location.uid])
}

export const IMAP_COPY_INCOMPLETE = 'Copied, original not removed'
export const IMAP_UNDO_UNVERIFIED = 'Undo unavailable: the IMAP server did not verify the moved UID'

async function readFlags(client: ImapClient, uid: number) {
  for await (const message of client.fetch([uid], { flags: true }, { uid: true })) {
    if (message.uid === uid) return message.flags ?? new Set<string>()
  }
}

async function openSource(
  client: ImapClient,
  source: Pick<MessageLocation, 'path_key' | 'validity'>,
  readOnly: boolean,
) {
  try {
    const box = await client.mailboxOpen(decodeURIComponent(source.path_key), { readOnly })
    return String(box.uidValidity) === source.validity
  } catch (error) {
    if (typeof error === 'object' && error && 'mailboxMissing' in error && error.mailboxMissing)
      return false
    throw error
  }
}

async function moveLookup(
  sync: ImapAccountSync,
  source: MessageLocation,
  destination: Folder,
  log: Logger,
) {
  if (!source.source_blob) {
    log.warn('IMAP move verification snapshot omitted because the source hash is missing')
    return
  }
  const row = sync.store.db
    .prepare('SELECT rfc_message_id FROM message WHERE id = ?')
    .get(source.message_id) as { rfc_message_id: string | null } | undefined
  if (!row?.rfc_message_id) {
    log.warn('IMAP move verification snapshot omitted because Message-ID is missing')
    return
  }
  try {
    const box = await sync.client.mailboxOpen(destination.path, { readOnly: true })
    if (box.uidValidity && Number.isSafeInteger(box.uidNext) && box.uidNext > 0) {
      return {
        messageId: row.rfc_message_id,
        validity: String(box.uidValidity),
        firstNewUid: box.uidNext,
      }
    }
  } catch {
    log.warn('IMAP move verification could not open the destination before the move')
    return
  }
  log.warn('IMAP move verification could not read destination UIDVALIDITY or UIDNEXT')
}

async function findMovedUid(
  client: ImapClient,
  move: Move,
  log: Logger,
  reportedValidity?: string,
) {
  const { destination, source, lookup } = move
  if (!lookup || !source.source_blob) {
    log.warn('IMAP move verification fallback skipped because the pre-move snapshot is missing')
    return
  }
  const { messageId, validity, firstNewUid } = lookup
  if (reportedValidity && reportedValidity !== validity) {
    log.warn(
      'IMAP move verification stopped because COPYUID disagrees with destination UIDVALIDITY',
    )
    return
  }

  let stage = 'open destination'
  try {
    const open = () => client.mailboxOpen(destination.path, { readOnly: true })
    if (String((await open()).uidValidity) !== validity) {
      log.warn('IMAP move verification stopped because destination UIDVALIDITY changed')
      return
    }
    stage = 'search by Message-ID'
    const matches = await client.search({ header: { 'Message-ID': messageId } }, { uid: true })
    if (!matches || !matches.length) {
      log.warn('IMAP move verification found no Message-ID candidates')
      return
    }

    stage = 'hash candidate source'
    let uid: number | undefined
    for (const candidate of new Set(matches)) {
      const { content } = await client.download(String(candidate), undefined, { uid: true })
      if (!content) {
        log.warn('IMAP move verification could not download a candidate')
        return
      }
      const hash = createHash('sha256')
      for await (const chunk of content) hash.update(chunk)
      if (hash.digest('hex') !== source.source_blob) continue
      // A UID already allocated before the move cannot identify the moved copy.
      if (uid !== undefined || candidate < firstNewUid) {
        log.warn('IMAP move verification found an ambiguous full-source match')
        return
      }
      uid = candidate
    }
    if (uid === undefined) {
      log.warn('IMAP move verification found no matching source hash')
      return
    }
    stage = 'recheck destination UIDVALIDITY'
    if (String((await open()).uidValidity) !== validity) {
      log.warn(
        'IMAP move verification stopped because destination UIDVALIDITY changed during lookup',
      )
      return
    }
    return { uid, validity }
  } catch {
    // Provider errors may include mail data.
    log.warn({ stage }, 'IMAP move verification fallback failed')
  }
}

async function readSourceSender(sync: ImapAccountSync, source: MessageLocation) {
  if (!source.source_blob) return null
  try {
    const file = await open(sync.store.blobs.path(source.source_blob), 'r')
    try {
      const bytes = Buffer.alloc(64 * 1024)
      const { bytesRead } = await file.read(bytes)
      const raw = bytes.subarray(0, bytesRead).toString('utf8')
      const end = raw.search(/\r?\n\r?\n/)
      if (end < 0) return null
      const headers = raw
        .slice(0, end)
        .replace(/\r?\n[ \t]+/g, ' ')
        .split(/\r?\n/)
      const from = headers.filter((line) => /^from:/i.test(line))
      const mailbox = from.length === 1 ? senderMailbox(from[0]?.slice(5).trim()) : null
      return normalizeSender(mailbox?.address)
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}

export async function executeImap(
  sync: ImapAccountSync,
  changes: ImapChange[],
  entry: ImapJournalEntry,
  save: () => void,
  allowTrash: boolean,
  beforeWrite: () => void,
  log: Logger,
  requireDestinationUid = false,
  screening?: { address?: string; filtered?: boolean; intoManaged: boolean },
) {
  const { client, store, accountId, locations } = sync
  const { table, name } = managedDestination(!!screening?.filtered)
  const unreadId = labelId(accountId, 'UNREAD')
  const starredId = labelId(accountId, 'STARRED')
  const isFlag = (id: string) => id === unreadId || id === starredId
  const done = new Set(
    [...entry.applied, ...entry.superseded, ...entry.failed, ...(entry.uncertain ?? [])].map(
      ({ message_id }) => message_id,
    ),
  )
  const folders = new Map<string, Folder>()
  const normalFolders = new Set<string>()

  const finishMove = async (change: ImapChange, move: Move, uid?: number, validity?: string) => {
    const { source, destination, flags } = move
    const path = decodeURIComponent(source.path_key)
    if (!uid || !validity) {
      log.warn('IMAP move returned incomplete COPYUID; verifying the destination UID')
      const recovered = await findMovedUid(client, move, log, validity)
      uid = recovered?.uid
      validity = recovered?.validity
      if (!recovered) await sync.refreshOrganiseFolder(destination)
    }
    transaction(store.db, () => {
      change.moveFrom = { path_key: source.path_key, validity: source.validity }
      const observed = uid && validity ? locations.get(destination.path, validity, uid) : undefined
      if (uid && validity && (!observed || observed.message_id === change.message_id)) {
        const revision = imapLocationRevision({
          path_key: encodeURIComponent(destination.path),
          validity,
          uid,
        })
        change.revisions = Object.fromEntries(Object.keys(change.after).map((id) => [id, revision]))
      } else {
        if (observed) log.warn('IMAP move destination UID is already assigned to another message')
        delete change.revisions
        if (requireDestinationUid)
          entry.error ??= screening
            ? 'The IMAP server did not verify the moved UID'
            : 'Snooze unavailable: the IMAP server did not verify the Archive UID'
      }
      entry.applied.push(change)
      delete entry.pending
      done.add(change.message_id)
      save()
      if (uid && validity && !observed) {
        locations.moved(source, destination, validity, uid, flags)
      } else {
        if (uid && validity && observed?.message_id === source.message_id)
          locations.inheritArrival(source, destination, validity, uid)
        locations.remove(path, source.validity, source.uid)
      }
    })
  }

  const removeCopiedSource = async (pending: Pending & { move: Move }, flags?: Set<string>) => {
    const { source, destination } = pending.move
    const { uid } = source
    const stopCopyCleanup = () => {
      entry.uncertain ??= []
      entry.uncertain.push(pending.change)
      done.add(pending.change.message_id)
      entry.error = IMAP_COPY_INCOMPLETE
      delete entry.pending
      save()
      return true
    }
    if (screening && (!pending.copied?.uid || !pending.copied.validity)) {
      const recovered = await findMovedUid(client, pending.move, log, pending.copied?.validity)
      if (!recovered) {
        stopCopyCleanup()
        await sync.refreshOrganiseFolder(destination)
        return true
      }
      pending.copied = recovered
      entry.pending = pending
      save()
      flags = undefined
    }
    if (screening) {
      const managedPath = screening.intoManaged
        ? destination.path
        : decodeURIComponent(source.path_key)
      if (!client.capabilities.has('UIDPLUS') || !normalFolders.has(managedPath))
        return stopCopyCleanup()

      const target = screening.intoManaged
        ? store.db
            .prepare(`
              SELECT validity, mailbox_id FROM ${table}
              WHERE account_id = ? AND provider_id = ? AND state = 'ready'
            `)
            .get(accountId, destination.label.providerId)
        : (pending.change.moveFrom ?? (screening.filtered ? pending.copied : undefined))
      const copied = pending.copied
      if (!target || !copied?.uid || copied.validity !== target.validity) return stopCopyCleanup()

      const box = await client.mailboxOpen(destination.path, { readOnly: true })
      if (
        String(box.uidValidity) !== target.validity ||
        ('mailbox_id' in target && target.mailbox_id && target.mailbox_id !== box.mailboxId)
      )
        return stopCopyCleanup()

      const targetFlags = await readFlags(client, copied.uid)
      if (!targetFlags || targetFlags.has('\\Deleted')) return stopCopyCleanup()
      flags = undefined
    }
    const current =
      flags ?? ((await openSource(client, source, false)) && (await readFlags(client, uid)))
    if (current === false) {
      transaction(store.db, () => {
        entry.failed.push(pending.change)
        entry.error = `${IMAP_COPY_INCOMPLETE}. The source folder changed; cleanup stopped`
        delete entry.pending
        done.add(pending.change.message_id)
        save()
        locations.remove(decodeURIComponent(source.path_key), source.validity, uid)
      })
      return true
    }
    beforeWrite()
    let removed = false
    try {
      removed =
        !current ||
        ((current.has('\\Deleted') ||
          (await client.messageFlagsAdd(String(uid), ['\\Deleted'], { uid: true }))) &&
          (await client.uidExpunge(uid)) &&
          !(await readFlags(client, uid)))
    } catch {
      // The copy is confirmed. A later pass can find this UID already gone if
      // the server removed it before the connection or its response was lost.
    }
    if (!removed) {
      await sync.refreshOrganiseFolder(destination)
      return false
    }
    await finishMove(pending.change, pending.move, pending.copied?.uid, pending.copied?.validity)
    return true
  }

  const uncertain = async () => {
    const pending = entry.pending
    if (!pending) return
    const move = pending.move
    const sourceExists = move
      ? (await openSource(client, move.source, true)) &&
        !!(await readFlags(client, move.source.uid))
      : false
    const destination = move && folders.get(labelId(accountId, move.destination.label.providerId))
    if (move && destination?.path === move.destination.path) {
      await sync.refreshOrganiseFolder(destination)
    }
    transaction(store.db, () => {
      entry.uncertain ??= []
      entry.uncertain.push(pending.change)
      entry.error ??= 'The IMAP server did not confirm the change'
      delete entry.pending
      done.add(pending.change.message_id)
      save()
      if (move && !sourceExists) {
        locations.remove(
          decodeURIComponent(move.source.path_key),
          move.source.validity,
          move.source.uid,
        )
      }
    })
  }

  if (
    entry.pending?.move ||
    changes.some(({ after }) => Object.keys(after).some((id) => !isFlag(id)))
  ) {
    const list = await client.list()
    for (const folder of mapFolders(list)) {
      folders.set(labelId(accountId, folder.label.providerId), folder)
      if (screening && normalUserFolder(list, folder.path)) normalFolders.add(folder.path)
    }
  }
  const pending = entry.pending
  if (pending?.move && pending.copied) {
    if (!(await removeCopiedSource({ ...pending, move: pending.move }))) return
  } else {
    await uncertain()
  }

  for (const change of changes) {
    const { message_id, before, after, revisions } = change
    if (done.has(message_id) || Object.keys(after).length === 0) continue
    const local = locations.forMessage(message_id)
    const [source] = local
    const finish = (kind: 'applied' | 'superseded' | 'failed', error?: string) => {
      if (error) entry.error ??= error
      entry[kind].push(change)
      delete entry.pending
      save()
    }

    const revision = Object.values(revisions ?? {})[0]
    const acknowledge = (location: Parameters<typeof imapLocationRevision>[0]) => {
      const observed = imapLocationRevision(location)
      change.revisions = Object.fromEntries(Object.keys(after).map((id) => [id, observed]))
      finish('applied')
    }
    const expectedFolders = Object.keys(before).filter((id) => !isFlag(id) && before[id])
    // Undo of a flag has only the inverted flag and the acknowledged location.
    if (!expectedFolders.length && source && revision) expectedFolders.push(source.label_id)
    if (
      !source?.verified ||
      expectedFolders.some((id) => !local.some(({ label_id }) => label_id === id)) ||
      local.some(({ label_id }) => !expectedFolders.includes(label_id)) ||
      (revision && revision !== imapLocationRevision(source))
    ) {
      if (change.moveFrom) finish('failed', 'Undo unavailable: the moved IMAP UID changed')
      else finish('superseded')
      continue
    }
    if (local.length !== 1) {
      finish('failed', 'This message has multiple IMAP locations')
      continue
    }

    const destinationId = Object.keys(after).find((id) => !isFlag(id) && after[id])
    let destination: Folder | undefined
    if (destinationId) {
      destination = folders.get(destinationId)
      const sourceFolder = folders.get(source.label_id)
      if (sourceFolder?.path !== decodeURIComponent(source.path_key)) {
        finish('superseded')
        continue
      }
      if (!destination) {
        finish(
          'failed',
          change.moveFrom
            ? 'Undo unavailable: the original IMAP folder is unavailable'
            : 'The IMAP destination folder is unavailable',
        )
        continue
      }
      if (
        screening &&
        !normalFolders.has(screening.intoManaged ? destination.path : sourceFolder.path)
      ) {
        finish('failed', `The ${name} folder is no longer a normal user folder`)
        continue
      }
      if (!allowTrash && (sourceFolder.trash || destination.trash)) {
        finish('failed', 'Only the owner can move mail to or from Trash')
        continue
      }
      if (
        change.moveFrom &&
        (encodeURIComponent(destination.path) !== change.moveFrom.path_key ||
          !(await openSource(client, change.moveFrom, true)))
      ) {
        finish('failed', 'Undo unavailable: the original IMAP folder changed')
        continue
      }
    }

    if (screening?.address && (await readSourceSender(sync, source)) !== screening.address) {
      finish('failed', 'The exact IMAP source Sender could not be verified')
      continue
    }
    if (screening && destination && (screening.intoManaged || screening.filtered)) {
      const managed = screening.intoManaged ? destination : folders.get(source.label_id)
      if (!managed) continue
      const saved = store.db
        .prepare(`
        SELECT validity, mailbox_id FROM ${table}
        WHERE account_id = ? AND provider_id = ? AND state = 'ready'
      `)
        .get(accountId, managed.label.providerId)
      const box = await client.mailboxOpen(managed.path, { readOnly: true })
      if (
        !saved ||
        String(box.uidValidity) !== saved.validity ||
        (saved.mailbox_id && saved.mailbox_id !== box.mailboxId)
      ) {
        store.db
          .prepare(`UPDATE ${table} SET state = 'repair', error = ? WHERE account_id = ?`)
          .run(`The managed ${name} folder changed`, accountId)
        finish('failed', `The managed ${name} folder changed`)
        continue
      }
    }
    const lookup = destination && (await moveLookup(sync, source, destination, log))
    const uid = String(source.uid)
    const path = decodeURIComponent(source.path_key)
    const flags = (await openSource(client, source, false)) && (await readFlags(client, source.uid))
    if (!flags || flags.has('\\Deleted')) {
      if (change.moveFrom) finish('failed', 'Undo unavailable: the moved IMAP UID changed')
      else finish('superseded')
      continue
    }
    const current = messageFlags(flags)
    const move = destination
      ? { source, destination, flags: current, ...(lookup && { lookup }) }
      : undefined
    locations.flags(path, source.validity, source.uid, current.unread, current.starred)
    const flagId = Object.keys(after).find(isFlag)
    if (flagId && (flagId === unreadId ? current.unread : current.starred) !== before[flagId]) {
      finish('superseded')
      continue
    }
    if (!move && (!flagId || before[flagId] === after[flagId])) continue

    beforeWrite()
    entry.pending = move ? { change, move } : { change }
    save()
    if (move) {
      const support = imapMoveSupport(client)
      if (!support.available) {
        finish('failed', 'This IMAP server does not support safe moves')
        continue
      }
      const response = support.native
        ? await client.uidMove(source.uid, move.destination.path)
        : await client.messageCopy(uid, move.destination.path, { uid: true })
      if (!response) {
        await uncertain()
        continue
      }
      const targetUid = response.uidMap?.get(source.uid)
      const targetValidity = response.uidValidity?.toString()
      if (support.native) {
        await finishMove(change, move, targetUid, targetValidity)
      } else {
        const copied = { change, move, copied: { uid: targetUid, validity: targetValidity } }
        entry.pending = copied
        save()
        if (!(await removeCopiedSource(copied, flags))) return
      }
    } else if (flagId) {
      const flag = flagId === unreadId ? '\\Seen' : '\\Flagged'
      const add = flagId === unreadId ? !after[flagId] : after[flagId]
      const options = { uid: true }
      const applied = add
        ? await client.messageFlagsAdd(uid, [flag], options)
        : await client.messageFlagsRemove(uid, [flag], options)
      if (!applied) {
        await uncertain()
        continue
      }
      const observed = await readFlags(client, source.uid)
      if (!observed || observed.has(flag) !== add) {
        await uncertain()
        continue
      }
      const updated = messageFlags(observed)
      transaction(store.db, () => {
        locations.flags(path, source.validity, source.uid, updated.unread, updated.starred)
        acknowledge(source)
      })
    }
  }
}
