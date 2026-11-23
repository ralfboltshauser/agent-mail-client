import { SEND_ACCOUNT_UNAVAILABLE } from '@amc/protocol'
import { GmailHttpError } from '../providers/gmail/http.ts'
import { OAuthError } from '../providers/gmail/oauth.ts'
import type { GmailApi } from '../providers/gmail/types.ts'
import { providerMessageId } from '../providers/imap/mapping.ts'
import { type ImapProvider, SmtpRejection } from '../providers/imap/provider.ts'
import { ImapThreads } from '../providers/imap/threading.ts'
import type { DraftMirror, Drafts } from './drafts.ts'
import { buildMessage } from './mime.ts'
import type { Delivery, FrozenMessage, Receipt } from './outbox.ts'
import { type IncomingMessage, type MailStore, messageId } from './store.ts'

function providerThread(message: FrozenMessage): string | undefined {
  return message.threadId?.slice(message.accountId.length + 1)
}

export function gmailDelivery(api: GmailApi): Delivery {
  return {
    async send(message, id) {
      const raw = await buildMessage({ ...message, messageId: id })
      try {
        const receipt = await api.sendMessage({ raw, threadId: providerThread(message) })
        if (!receipt?.id || !receipt.threadId) throw new Error('Missing Gmail send receipt')
        return {
          kind: 'accepted',
          receipt: { providerId: receipt.id, providerThreadId: receipt.threadId },
        }
      } catch (error) {
        if (
          (error instanceof OAuthError && error.needsReauth) ||
          (error instanceof GmailHttpError && error.status === 401)
        ) {
          return { kind: 'failed', detail: SEND_ACCOUNT_UNAVAILABLE }
        }
        if (error instanceof GmailHttpError) {
          if (
            error.status === 429 ||
            (error.status === 403 &&
              /^(rateLimitExceeded|userRateLimitExceeded|quotaExceeded)$/.test(error.reason))
          ) {
            return { kind: 'retry', afterMs: error.retryAfterMs }
          }
          if ([400, 404, 413].includes(error.status))
            return {
              kind: 'failed',
              detail:
                'Gmail rejected this message. Review the draft or reconnect the Account before trying again.',
            }
        }
        throw error
      }
    },
    async find(_message, id) {
      const matches = await api.listMessages({ q: `in:sent rfc822msgid:<${id}>`, maxResults: 25 })
      for (const match of matches.messages ?? []) {
        const sent = await api.getMessage(match.id, true)
        if (
          sent?.labelIds?.includes('SENT') &&
          sent.payload?.headers?.some(
            (header) =>
              header.name.toLowerCase() === 'message-id' &&
              header.value.trim().replace(/^<|>$/g, '') === id,
          )
        )
          return { providerId: match.id, providerThreadId: match.threadId }
      }
      return null
    },
  }
}

export function imapDelivery(api: ImapProvider): Delivery {
  const receipt = (
    message: FrozenMessage,
    id: string,
    providerId: string,
    detail?: string,
  ): Receipt => ({
    providerId,
    providerThreadId: providerThread(message) ?? `imap:${encodeURIComponent(id)}`,
    detail,
  })
  return {
    async send(message, id) {
      let sent: Awaited<ReturnType<ImapProvider['send']>>
      try {
        sent = await api.send({ ...message, messageId: id })
      } catch (error) {
        if (error instanceof SmtpRejection) return { kind: 'failed', detail: error.message }
        throw error
      }
      const detail = [
        sent.rejected.length ? `${sent.rejected.length} recipient(s) were rejected by SMTP.` : null,
        sent.sentCopy === 'failed'
          ? 'SMTP accepted the message. The Sent copy could not be saved.'
          : null,
      ]
        .filter(Boolean)
        .join(' ')
      return {
        kind: 'accepted',
        receipt: {
          ...receipt(message, id, `amc-sent:${id}`, detail || undefined),
          allRecipientsAccepted: sent.rejected.length === 0,
        },
      }
    },
    async find(message, id) {
      const location = await api.findSent(id)
      return location
        ? receipt(
            message,
            id,
            providerMessageId(location.folder, location.uidValidity, location.uid),
          )
        : null
    },
  }
}

export function imapDraftMirror(
  api: ImapProvider,
  currentEndpoint?: () => string | undefined,
): DraftMirror {
  return {
    imap: true,
    draftIdAt: (folder, uid, uidValidity) => api.draftId(folder, uid, uidValidity),
    saveDraft: async ({ raw }) => {
      const saved = await api.saveDraft(raw)
      return { ...saved, message: { ...saved.message, threadId: '' } }
    },
    deleteDraft: (id, sourceHash) => api.deleteDraft(id, sourceHash ?? null, currentEndpoint),
  }
}

export function publishSent(
  store: MailStore,
  drafts: Drafts,
  message: FrozenMessage,
  id: string,
  receipt: Receipt,
) {
  const { db } = store
  const kind = db.prepare('SELECT kind FROM account WHERE id = ?').get(message.accountId)?.kind
  const existing =
    kind === 'imap'
      ? db
          .prepare(
            "SELECT id FROM message WHERE account_id = ? AND trim(rfc_message_id, '<>') = ? AND EXISTS (SELECT 1 FROM json_each(label_ids) WHERE value = ?) LIMIT 1",
          )
          .get(message.accountId, id, `${message.accountId}:SENT`)
      : store.hasMessage(message.accountId, receipt.providerId)
  if (!existing && kind) {
    const sent: IncomingMessage = {
      providerId: receipt.providerId,
      providerThreadId: receipt.providerThreadId,
      rfcMessageId: id,
      inReplyTo: message.inReplyTo ?? null,
      references: message.references ?? null,
      from: message.from,
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      replyTo: [],
      subject: message.subject,
      snippet: message.text.trim().slice(0, 220),
      bodyText: message.text,
      bodyHtml: message.html ?? null,
      sentAt: Date.now(),
      size: Buffer.byteLength(message.text),
      labels: ['SENT'],
      listUnsubscribe: null,
      attachments: message.attachments.map((part) => {
        const bytes = Buffer.from(part.content, 'base64')
        return {
          providerAttachmentId: null,
          filename: part.filename,
          mimeType: part.mimeType,
          size: bytes.length,
          contentId: part.contentId ?? null,
          inline: Boolean(part.contentId),
          data: bytes,
        }
      }),
    }
    store.putMessage(message.accountId, [message.from.address], sent)
    if (kind === 'imap')
      new ImapThreads(store, message.accountId).remember(
        sent,
        messageId(message.accountId, sent.providerId),
      )
  }
  drafts.finishSend(message, receipt.allRecipientsAccepted)
}
