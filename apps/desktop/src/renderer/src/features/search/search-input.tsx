import { Loader2, Search, X } from 'lucide-react'
import { ActionHint } from '@/components/action-hint'
import { Button } from '@/components/ui/button'
import { mailShortcuts, shortcutLabel } from '@/lib/mail-shortcuts'
import type { useMailSearch } from './use-mail-search'

export function SearchInput({
  mailSearch,
  move,
}: {
  mailSearch: ReturnType<typeof useMailSearch>
  move: (delta: number) => void
}) {
  const {
    search,
    filterText,
    input: searchInput,
    changeFilter,
    runSearch,
    clearSearch,
  } = mailSearch
  return (
    <div className="relative ml-auto min-w-20 max-w-52 flex-1">
      {search?.loading ? (
        <Loader2 className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 motion-safe:animate-spin text-muted-foreground" />
      ) : (
        <Search className="absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      )}
      <ActionHint
        label="Filter mail or search all mail"
        shortcuts={[mailShortcuts.filterMail, mailShortcuts.searchMail]}
      >
        <input
          ref={searchInput}
          aria-label="Filter mail or press Enter to search all mail"
          value={search ? search.text : filterText}
          onChange={(e) => changeFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void runSearch((search?.text ?? filterText).trim())
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              searchInput.current?.blur()
              move(1)
            }
          }}
          placeholder="Filter mail"
          className="h-8 w-full rounded-md border border-transparent bg-muted pr-8 pl-8 text-xs outline-none placeholder:text-muted-foreground focus:border-ring/50 focus:bg-background"
        />
      </ActionHint>
      {(search || filterText) && (
        <ActionHint label="Clear search" shortcuts={[mailShortcuts.escape]}>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Clear search"
            onClick={clearSearch}
            className="absolute top-1/2 right-1 -translate-y-1/2 text-muted-foreground"
          >
            <X />
          </Button>
        </ActionHint>
      )}
      {!search && !filterText && (
        <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-xs text-muted-foreground">
          {shortcutLabel(mailShortcuts.filterMail)}
        </kbd>
      )}
    </div>
  )
}
