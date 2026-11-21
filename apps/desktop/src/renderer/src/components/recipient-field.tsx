import type { Address, Contact } from '@amc/protocol'
import { X } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { getAmc } from '@/lib/amc'
import { Button } from './ui/button'
import { Input } from './ui/input'

export function RecipientField({
  label,
  recipients,
  onChange,
}: {
  label: string
  recipients: Address[]
  onChange: (addresses: Address[]) => void
}) {
  const id = useId()
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<Contact[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const choices = matches.filter(
    (match) => !recipients.some((r) => r.address.toLowerCase() === match.address.toLowerCase()),
  )
  const visible = open && query.trim() && choices.length > 0

  useEffect(() => {
    if (!query.trim() || !open) return
    let stale = false
    const timer = window.setTimeout(() => {
      void getAmc()
        .contacts(query)
        .then((contacts) => {
          if (!stale) setMatches(contacts)
        })
        .catch(() => {})
    }, 140)
    return () => {
      stale = true
      window.clearTimeout(timer)
    }
  }, [query, open])

  const add = (addresses: Address[]) => {
    const seen = new Set(recipients.map((r) => r.address.toLowerCase()))
    onChange([
      ...recipients,
      ...addresses.filter((r) => {
        const key = r.address.toLowerCase()
        if (seen.has(key)) return false
        seen.add(key)
        return true
      }),
    ])
    setQuery('')
    setMatches([])
    setActive(-1)
  }

  const commit = (value: string) => {
    const addresses = value
      .split(/[,;]/)
      .map((word) => word.trim())
      .filter(Boolean)
    if (!addresses.length || addresses.some((word) => !/^[^\s@,<>]+@[^\s@,<>]+$/.test(word))) return
    add(addresses.map((address) => ({ address, name: null })))
  }

  return (
    <div className="relative grid grid-cols-[3rem_1fr] items-start border-b px-4 py-1.5">
      <label htmlFor={id} className="pt-1.5 text-sm text-muted-foreground">
        {label}
      </label>
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {recipients.map((r, index) => (
          <span
            key={r.address}
            title={r.address}
            className="flex max-w-full items-center gap-0.5 rounded-md bg-muted pl-2 text-xs"
          >
            <span className="truncate">{r.name || r.address}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove ${r.address}`}
              onClick={() => onChange(recipients.filter((_, at) => at !== index))}
            >
              <X />
            </Button>
          </span>
        ))}
        <Input
          id={id}
          data-recipient-input="true"
          role="combobox"
          aria-expanded={Boolean(visible)}
          aria-autocomplete="list"
          aria-controls={visible ? `${id}-choices` : undefined}
          aria-activedescendant={visible && choices[active] ? `${id}-${active}` : undefined}
          className="h-8 w-auto min-w-36 flex-1 border-0 bg-transparent shadow-none focus-visible:ring-1 dark:bg-transparent"
          value={query}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            commit(query)
            setOpen(false)
          }}
          onChange={(event) => {
            setQuery(event.target.value)
            setMatches([])
            setActive(-1)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && visible) {
              event.preventDefault()
              event.stopPropagation()
              setOpen(false)
            } else if (visible && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
              event.preventDefault()
              setActive((index) =>
                index < 0
                  ? event.key === 'ArrowDown'
                    ? 0
                    : choices.length - 1
                  : (index + choices.length + (event.key === 'ArrowDown' ? 1 : -1)) %
                    choices.length,
              )
            } else if (!event.metaKey && (event.key === 'Enter' || event.key === ',')) {
              event.preventDefault()
              if (visible && choices[active]) add([choices[active]])
              else commit(query)
            } else if (event.key === 'Backspace' && !query) {
              onChange(recipients.slice(0, -1))
            }
          }}
        />
      </div>
      {visible && (
        <div
          id={`${id}-choices`}
          role="listbox"
          aria-label={`${label} contacts`}
          className="absolute top-full right-4 left-16 z-10 max-h-52 overflow-auto rounded-md border bg-popover p-1 shadow-md"
        >
          {choices.map((contact, index) => (
            <div
              key={contact.address}
              id={`${id}-${index}`}
              role="option"
              tabIndex={-1}
              aria-selected={index === active}
              className={index === active ? 'rounded bg-accent' : ''}
            >
              <Button
                variant="ghost"
                tabIndex={-1}
                className="h-auto w-full justify-start gap-2 p-2"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => add([contact])}
              >
                <span className="truncate">{contact.name ?? contact.address}</span>
                {contact.name && (
                  <span className="truncate text-xs text-muted-foreground">{contact.address}</span>
                )}
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
