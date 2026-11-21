import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { JWT } from 'google-auth-library'

interface Notification {
  ackId: string
  address?: string
}

export interface GmailPubSub {
  topic: string
  pull(signal: AbortSignal): Promise<Notification[]>
  acknowledge(ackIds: string[], signal: AbortSignal): Promise<void>
}

interface PullResponse {
  receivedMessages?: { ackId: string; message?: { data?: string } }[]
}

function notificationAddress(data?: string): string | undefined {
  if (!data) return undefined
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'))
    if (typeof payload?.emailAddress === 'string') return payload.emailAddress.toLowerCase()
  } catch {
    // Unusable messages can be acknowledged. They cannot wake a Gmail account.
  }
}

export function gmailPubSub(project: string, secretsDir: string): GmailPubSub {
  const subscription = `projects/${project}/subscriptions/amc-gmail-host`
  const keyFile = join(secretsDir, 'gmail-pubsub-subscriber.json')
  let auth: JWT | undefined

  const post = async (
    action: 'pull' | 'acknowledge',
    body: object,
    timeout: number,
    signal: AbortSignal,
  ) => {
    let token: string | null | undefined
    try {
      if (!auth) {
        const { client_email, private_key } = JSON.parse(readFileSync(keyFile, 'utf8'))
        if (typeof client_email !== 'string' || typeof private_key !== 'string') {
          throw new Error('Invalid service account credentials')
        }
        auth = new JWT({
          email: client_email,
          key: private_key,
          scopes: ['https://www.googleapis.com/auth/pubsub'],
          transporterOptions: { timeout: 10_000 },
        })
      }
      token = (await auth.getAccessToken()).token
    } catch {
      auth = undefined
      throw new Error(`Cannot authenticate Gmail Pub/Sub using ${keyFile}`)
    }
    if (!token) throw new Error('No Gmail Pub/Sub access token')
    const response = await fetch(`https://pubsub.googleapis.com/v1/${subscription}:${action}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    })
    if (response.status === 401) auth = undefined
    if (!response.ok) throw new Error(`Pub/Sub ${action}: HTTP ${response.status}`)
    return response
  }

  return {
    topic: `projects/${project}/topics/amc-gmail`,
    async pull(signal) {
      const response = await post('pull', { maxMessages: 100 }, 120_000, signal)
      const { receivedMessages }: PullResponse = await response.json()
      return (receivedMessages ?? []).map(({ ackId, message }) => ({
        ackId,
        address: notificationAddress(message?.data),
      }))
    },
    async acknowledge(ackIds, signal) {
      await post('acknowledge', { ackIds }, 10_000, signal)
    },
  }
}
