import type { LabelPatch } from '@amc/protocol'
import { transaction } from '../../db/database.ts'
import { labelId } from '../../mail/store.ts'
import { type ImapClient, imapMoveSupport } from './client.ts'
import type { MessageLocation } from './locations.ts'
import { type Folder, mapFolders, messageFlags } from './mapping.ts'
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

export async function executeImap(
  sync: ImapAccountSync,
  changes: ImapChange[],
  entry: ImapJournalEntry,
  save: () => void,
  allowTrash: boolean,
  beforeWrite: () => void,
  requireDestinationUid = false,
) {
  const { client, store, accountId, locations } = sync
  const unreadId = labelId(accountId, 'UNREAD')
  const starredId = labelId(accountId, 'STARRED')
  const isFlag = (id: string) => id === unreadId || id === starredId
  const done = new Set(
    [...entry.applied, ...entry.superseded, ...entry.failed, ...(entry.uncertain ?? [])].map(
      ({ message_id }) => message_id,
    ),
  )
  const folders = new Map<string, Folder>()

  const finishMove = async (change: ImapChange, move: Move, uid?: number, validity?: string) => {
    const { source, destination, flags } = move
    const path = decodeURIComponent(source.path_key)
    if (!uid || !validity) await sync.refreshOrganiseFolder(destination)
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
        delete change.revisions
        if (requireDestinationUid)
          entry.error ??= 'Snooze unavailable: the IMAP server did not verify the Archive UID'
      }
      entry.applied.push(change)
      delete entry.pending
      done.add(change.message_id)
      save()
      if (uid && validity && !observed) locations.moved(source, destination, validity, uid, flags)
      else locations.remove(path, source.validity, source.uid)
    })
  }

  const removeCopiedSource = async (pending: Pending & { move: Move }, flags?: Set<string>) => {
    const { source, destination } = pending.move
    const { uid } = source
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
    for (const folder of mapFolders(await client.list())) {
      folders.set(labelId(accountId, folder.label.providerId), folder)
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

    const uid = String(source.uid)
    const path = decodeURIComponent(source.path_key)
    const flags = (await openSource(client, source, false)) && (await readFlags(client, source.uid))
    if (!flags || flags.has('\\Deleted')) {
      if (change.moveFrom) finish('failed', 'Undo unavailable: the moved IMAP UID changed')
      else finish('superseded')
      continue
    }
    const current = messageFlags(flags)
    const move = destination ? { source, destination, flags: current } : undefined
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
