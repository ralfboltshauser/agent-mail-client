import { CornerDownLeft, Loader2, Search, TextCursorInput, Users, X } from 'lucide-react'
import { type KeyboardEvent, useId, useState } from 'react'
import { ActionHint } from '@/components/action-hint'
import { Button } from '@/components/ui/button'
import { ariaShortcut, mailShortcuts, shortcutLabel } from '@/lib/mail-shortcuts'
import type { useMailSearch } from './use-mail-search'

export function SearchInput({
  mailSearch,
  scope,
  mailboxTitle,
  focusResults,
}: {
  mailSearch: ReturnType<typeof useMailSearch>
  scope: string
  mailboxTitle: string
  focusResults: () => void
}) {
  const { search, text, input, changeFilter, runSearch, clearSearch, structured, needsValue } =
    mailSearch
  const [open, setOpen] = useState(false)
  const panelId = useId()
  const hintId = useId()

  const submit = () => {
    if (!text.trim() || needsValue) return
    input.current?.focus()
    setOpen(false)
    void runSearch(text)
  }

  const addField = (field: string) => {
    const query = text.trim().replace(/(?:^|\s)(?:from|to|cc|subject|after|before):$/i, '')
    changeFilter(query ? `${query} ${field}` : field)
    input.current?.focus()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    if (event.key === 'Escape' && open && !event.repeat) {
      event.preventDefault()
      event.stopPropagation()
      input.current?.focus()
      setOpen(false)
    }
    if (event.target !== input.current) return
    if (event.key === 'Enter') {
      event.preventDefault()
      submit()
    } else if (
      event.key === 'ArrowDown' &&
      !event.shiftKey &&
      !event.metaKey &&
      !event.altKey &&
      !event.ctrlKey
    ) {
      event.preventDefault()
      focusResults()
    } else if (event.key.toLowerCase() === 'f' && event.metaKey) {
      event.preventDefault()
      setOpen(true)
    }
  }

  const hint = needsValue
    ? 'Enter a value after the colon.'
    : search
      ? `History results · ${scope}`
      : structured
        ? 'Use quotes for a phrase.'
        : `Filters ${mailboxTitle} as you type`

  return (
    // biome-ignore lint/a11y/useSemanticElements: The renderer test DOM does not implement <search>.
    <div
      role="search"
      aria-label="Mail"
      className="app-no-drag ml-auto min-w-24 max-w-88 flex-1 shrink @max-[250px]:col-span-2 @max-[250px]:w-full"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false)
      }}
      onKeyDown={handleKeyDown}
    >
      <div className="relative flex h-8 items-center gap-2 rounded-md border bg-muted/60 px-2.5 focus-within:border-ring focus-within:bg-background">
        {search?.loading ? (
          <Loader2
            aria-label="Searching mail"
            className="size-3.5 shrink-0 text-muted-foreground motion-safe:animate-spin"
          />
        ) : (
          <Search aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
        )}
        <input
          ref={input}
          aria-label="Search mail"
          aria-controls={open ? panelId : undefined}
          aria-describedby={open ? hintId : undefined}
          aria-keyshortcuts={`${ariaShortcut(mailShortcuts.filterMail)} ${ariaShortcut(mailShortcuts.searchMail)}`}
          autoComplete="off"
          spellCheck={false}
          value={text}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onChange={(event) => {
            changeFilter(event.target.value)
            setOpen(true)
          }}
          placeholder="Search mail"
          className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
        />
        {text ? (
          <ActionHint label="Clear search" shortcuts={open ? [] : [mailShortcuts.escape]}>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-label="Clear search"
              onClick={() => {
                clearSearch()
                input.current?.focus()
                setOpen(false)
              }}
              className="-mr-1 shrink-0 text-muted-foreground"
            >
              <X />
            </Button>
          </ActionHint>
        ) : (
          <kbd className="rounded border px-1 font-sans text-[10px] leading-4 text-muted-foreground @max-[250px]:hidden">
            {shortcutLabel(mailShortcuts.searchMail)}
          </kbd>
        )}
      </div>
      {open && (
        <div
          id={panelId}
          className="absolute top-full right-3.5 z-30 mt-1.5 w-[calc(100%-1.75rem)] max-w-88 rounded-lg border bg-popover p-1.5 text-popover-foreground shadow-lg"
        >
          <button
            type="button"
            disabled={!text.trim() || needsValue}
            onClick={submit}
            className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left enabled:hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
          >
            <Search
              aria-hidden="true"
              className="size-4 shrink-0 text-muted-foreground @max-[250px]:hidden"
            />
            <span className="min-w-0 flex-1">
              <span className="block text-xs font-medium">Search all mail</span>
              <span className="block truncate text-xs text-muted-foreground" title={scope}>
                {scope}
              </span>
            </span>
            <kbd aria-label="Enter" className="rounded border p-0.5 text-muted-foreground">
              <CornerDownLeft aria-hidden="true" className="size-3" />
            </kbd>
          </button>
          <div className="mt-1 border-t px-2 pt-2 pb-1">
            <div className="flex flex-wrap gap-1.5">
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => addField('from:')}
                title="Match people in a message"
              >
                <Users />
                People
              </Button>
              <Button
                type="button"
                size="xs"
                variant="outline"
                onClick={() => addField('subject:')}
                title="Match words in the subject"
              >
                <TextCursorInput />
                Subject
              </Button>
            </div>
            <div id={hintId} className="mt-2 text-xs text-muted-foreground">
              {hint}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
