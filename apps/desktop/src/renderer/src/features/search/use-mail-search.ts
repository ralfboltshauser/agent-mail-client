import { MAIL_SEARCH_PAGE_SIZE, type SearchHit } from '@amc/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { getAmc } from '@/lib/amc'
import { failureText, recordCaughtFailure } from '@/lib/failure'

interface HistorySearch {
  accountId: string | null
  text: string
  engineOrigin?: string
  hits: SearchHit[] | null
  hasMore: boolean
  offset: number
  loading: boolean
  failed: boolean
  failure?: string
}

export function useMailSearch(accountId: string | null) {
  const [filterText, setFilterText] = useState('')
  const [history, setHistory] = useState<HistorySearch | null>(null)
  const request = useRef(0)
  const input = useRef<HTMLInputElement>(null)
  const search = history?.accountId === accountId ? history : null
  const text = search?.text ?? filterText
  // Match the Engine's token boundaries, including quoted phrases and cc:.
  const fields = (text.match(/(\w+:)?"[^"]*"|\S+/g) ?? [])
    .map((token) => /^(?:from|to|cc|subject|after|before):(.*)$/i.exec(token)?.[1])
    .filter((value) => value !== undefined)
  const structured = fields.length > 0
  const needsValue = fields.some(
    (value) =>
      !value || (value.startsWith('"') && (!value.endsWith('"') || !value.slice(1, -1).trim())),
  )
  const filter = structured ? '' : filterText.trim()

  useEffect(
    () => () => {
      request.current++
    },
    [],
  )

  const resetSearch = useCallback((clearFilter: boolean) => {
    request.current++
    setHistory(null)
    if (clearFilter) setFilterText('')
  }, [])

  const changeFilter = (text: string) => {
    resetSearch(false)
    setFilterText(text)
  }

  const clearSearch = () => {
    resetSearch(true)
    input.current?.blur()
  }

  const runSearch = async (text: string, scope = accountId, offset = 0, engineOrigin?: string) => {
    text = text.trim()
    if (!text) return
    const generation = ++request.current
    const matches = (current: HistorySearch | null): current is HistorySearch =>
      current?.accountId === scope && current.text === text && current.engineOrigin === engineOrigin
    setHistory((current) => ({
      accountId: scope,
      text,
      engineOrigin,
      offset,
      hasMore: matches(current) && current.hasMore,
      hits: matches(current) ? current.hits : null,
      loading: true,
      failed: matches(current) && current.failed,
      failure: matches(current) ? current.failure : undefined,
    }))
    try {
      const hits = engineOrigin
        ? await getAmc().search(text, scope, offset, engineOrigin)
        : offset
          ? await getAmc().search(text, scope, offset)
          : await getAmc().search(text, scope)
      if (generation === request.current) {
        setHistory((current) => {
          const previous = offset && matches(current) ? (current.hits ?? []) : []
          const combined = [...new Map([...previous, ...hits].map((hit) => [hit.id, hit])).values()]
          return {
            accountId: scope,
            text,
            engineOrigin,
            hits: combined,
            offset: offset + hits.length,
            hasMore: hits.length === MAIL_SEARCH_PAGE_SIZE && combined.length > previous.length,
            loading: false,
            failed: false,
          }
        })
      }
    } catch (error) {
      if (generation === request.current) {
        const failure = failureText(error)
        setHistory((current) => ({
          accountId: scope,
          text,
          engineOrigin,
          offset,
          hasMore: matches(current) && current.hasMore,
          hits: matches(current) ? current.hits : null,
          loading: false,
          failed: true,
          failure,
        }))
      } else recordCaughtFailure(error)
    }
  }

  return {
    text,
    filter,
    structured,
    needsValue,
    search,
    input,
    resetSearch,
    changeFilter,
    clearSearch,
    runSearch,
    retrySearch: () =>
      search && runSearch(search.text, accountId, search.offset, search.engineOrigin),
    loadMore: () =>
      search?.hasMore &&
      !search.loading &&
      runSearch(search.text, accountId, search.offset, search.engineOrigin),
  }
}
