import type { SearchHit } from '@amc/protocol'
import { useCallback, useEffect, useRef, useState } from 'react'
import { getAmc } from '@/lib/amc'

interface HistorySearch {
  accountId: string | null
  text: string
  hits: SearchHit[] | null
  loading: boolean
  failed: boolean
}

export function useMailSearch(accountId: string | null) {
  const [filterText, setFilterText] = useState('')
  const [history, setHistory] = useState<HistorySearch | null>(null)
  const request = useRef(0)
  const input = useRef<HTMLInputElement>(null)
  const search = history?.accountId === accountId ? history : null

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

  const runSearch = async (text: string) => {
    text = text.trim()
    if (!text) return
    const generation = ++request.current
    const matches = (current: HistorySearch | null): current is HistorySearch =>
      current?.accountId === accountId && current.text === text
    setHistory((current) => ({
      accountId,
      text,
      hits: matches(current) ? current.hits : null,
      loading: true,
      failed: matches(current) && current.failed,
    }))
    try {
      const hits = await getAmc().search(text, accountId)
      if (generation === request.current) {
        setHistory({ accountId, text, hits, loading: false, failed: false })
      }
    } catch {
      if (generation === request.current) {
        setHistory((current) => ({
          accountId,
          text,
          hits: matches(current) ? current.hits : null,
          loading: false,
          failed: true,
        }))
      }
    }
  }

  return { filterText, search, input, resetSearch, changeFilter, clearSearch, runSearch }
}
