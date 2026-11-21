import type { LabelPatch } from '@amc/protocol'
import { transaction } from '../../db/database.ts'
import { labelId } from '../../mail/store.ts'
import type { ImapClient } from './client.ts'
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
}

interface Move {
  source: MessageLocation
  destination: Folder
  validity: string
  firstUid: number
}

interface Pending {
  change: ImapChange
  move?: Move
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

export function imapMoveSupport(client: ImapClient) {
  const native =
    client.capabilities.has('MOVE') ||
    client.enabled.has('IMAP4REV2') ||
    (client.capabilities.has('IMAP4rev2') && !client.capabilities.has('IMAP4rev1'))
  return { native, available: native || client.capabilities.has('UIDPLUS') }
}

async function readFlags(client: ImapClient, uid: number) {
  for await (const message of client.fetch([uid], { flags: true }, { uid: true })) {
    if (message.uid === uid) return message.flags
  }
}

async function openSource(client: ImapClient, source: MessageLocation, readOnly: boolean) {
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
  await uncertain()

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
      finish('superseded')
      continue
    }
    if (local.length !== 1) {
      finish('failed', 'This message has multiple IMAP locations')
      continue
    }

    const destinationId = Object.keys(after).find((id) => !isFlag(id) && after[id])
    let move: Move | undefined
    const moveSupport = imapMoveSupport(client)
    if (destinationId) {
      const destination = folders.get(destinationId)
      const sourceFolder = folders.get(source.label_id)
      if (sourceFolder?.path !== decodeURIComponent(source.path_key)) {
        finish('superseded')
        continue
      }
      if (!destination || !moveSupport.available) {
        finish(
          'failed',
          !destination
            ? 'The IMAP destination folder is unavailable'
            : 'This IMAP server does not support safe moves',
        )
        continue
      }
      const box = await client.mailboxOpen(destination.path, { readOnly: true })
      move = { source, destination, validity: String(box.uidValidity), firstUid: box.uidNext }
    }

    const uid = String(source.uid)
    const path = decodeURIComponent(source.path_key)
    const flags = (await openSource(client, source, false)) && (await readFlags(client, source.uid))
    if (!flags || flags.has('\\Deleted')) {
      finish('superseded')
      continue
    }
    const current = messageFlags(flags)
    locations.flags(path, source.validity, source.uid, current.unread, current.starred)
    const flagId = Object.keys(after).find(isFlag)
    if (flagId && (flagId === unreadId ? current.unread : current.starred) !== before[flagId]) {
      finish('superseded')
      continue
    }
    if (!move && (!flagId || before[flagId] === after[flagId])) continue

    entry.pending = move ? { change, move } : { change }
    save()
    if (move) {
      const response = moveSupport.native
        ? await client.messageMove(uid, move.destination.path, { uid: true })
        : await client.messageCopy(uid, move.destination.path, { uid: true })
      if (!response || (!moveSupport.native && !(await client.messageDelete(uid, { uid: true })))) {
        await uncertain()
        continue
      }
      const targetUid = response.uidMap?.get(source.uid)
      const targetValidity = response.uidValidity?.toString()
      if (targetUid && targetValidity) {
        const target = move
        transaction(store.db, () => {
          locations.moved(source, target.destination, targetValidity, targetUid, current)
          acknowledge({
            path_key: encodeURIComponent(target.destination.path),
            validity: targetValidity,
            uid: targetUid,
          })
        })
      } else {
        // COPYUID is optional. Discover the new UID with the same fingerprint lookup as sync.
        await sync.refreshOrganiseFolder(move.destination)
        const target = locations
          .forMessage(message_id)
          .filter(
            (item) =>
              item.path_key === encodeURIComponent(move.destination.path) &&
              item.validity === move.validity &&
              item.uid >= move.firstUid,
          )
        const sourceExists =
          (await openSource(client, source, true)) && (await readFlags(client, source.uid))
        const [location] = target
        if (target.length !== 1 || !location || sourceExists) {
          await uncertain()
          continue
        }
        transaction(store.db, () => {
          acknowledge(location)
          locations.remove(path, source.validity, source.uid)
        })
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
