import type { SmartInboxApi } from '../../../../shared/api'
import { type Candidate, cardKey, type ReviewAction, reviewError } from './model'

export async function loadQueue(smart: SmartInboxApi, accountId: string | undefined) {
  // A change between pages invalidates the cursor and the entire partial snapshot.
  for (let attempt = 0; ; attempt++) {
    const cards: Candidate[] = []
    let cursor: string | null = null
    try {
      do {
        const page = await smart.triageQueue({
          accountId,
          limit: 100,
          ...(cursor ? { cursor } : {}),
        })
        if (!page.reviewLookup) throw new Error('Update the Engine to use desktop triage review.')
        cards.push(...page.cards)
        cursor = page.cursor
      } while (cursor)
      return cards
    } catch (error) {
      if (attempt === 2 || !reviewError(error).includes('Triage queue changed.')) throw error
    }
  }
}

export function partitionQueue(cards: Candidate[], skips: ReviewAction[], history: ReviewAction[]) {
  const skippedKeys = new Set(skips.map(({ card }) => cardKey(card)))
  const pendingMessages = new Set(
    history.filter(({ status }) => status === 'pending').map(({ messageId }) => messageId),
  )
  const ready: Candidate['id'][] = []
  const skipped: Candidate['id'][] = []
  let pending = 0
  for (const { id, messageId } of cards) {
    if (pendingMessages.has(messageId)) pending++
    else if (skippedKeys.has(cardKey(id))) skipped.push(id)
    else ready.push(id)
  }
  return { ready, skipped, pending }
}
