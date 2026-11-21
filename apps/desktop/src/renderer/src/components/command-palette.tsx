import { type AccountSummary, type Label, SNOOZED_LABEL } from '@amc/protocol'
import { Moon, RefreshCw, Search, Sun, Tag, Undo2, Users } from 'lucide-react'
import { useState } from 'react'
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from '@/components/ui/command'
import type { View } from '../../../shared/api'
import { SYSTEM_VIEWS } from './app-sidebar'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  accounts: AccountSummary[]
  labels: Label[]
  onView: (view: View) => void
  onAccount: (id: string | null) => void
  onSearch: (text: string) => void
  onToggleTheme: () => void
  dark: boolean
  organise: { name: string; shortcut: string; icon: typeof Moon; run: () => void }[]
  undo: () => void
}

/** ⌘K: every action, reachable by typing. */
export function CommandPalette({
  open,
  onOpenChange,
  accounts,
  labels,
  onView,
  onAccount,
  onSearch,
  onToggleTheme,
  dark,
  organise,
  undo,
}: Props) {
  const [query, setQuery] = useState('')
  const run = (fn: () => void) => () => {
    onOpenChange(false)
    setQuery('')
    fn()
  }
  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Command palette"
      description="Go anywhere, do anything"
    >
      <CommandInput
        placeholder="Type a command or search mail…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        <CommandEmpty>Nothing matches.</CommandEmpty>
        {query.trim() && (
          <CommandGroup heading="Search">
            <CommandItem value={`search ${query}`} onSelect={run(() => onSearch(query.trim()))}>
              <Search />
              Search all mail for “{query.trim()}”<CommandShortcut>↵</CommandShortcut>
            </CommandItem>
          </CommandGroup>
        )}
        <CommandGroup heading="Organise">
          {organise.map((item) => (
            <CommandItem key={item.name} value={item.name} onSelect={run(item.run)}>
              <item.icon />
              {item.name}
              <CommandShortcut>{item.shortcut}</CommandShortcut>
            </CommandItem>
          ))}
          <CommandItem value="undo organise" onSelect={run(undo)}>
            <Undo2 />
            Undo
            <CommandShortcut>Z</CommandShortcut>
          </CommandItem>
        </CommandGroup>
        <CommandGroup heading="Go to">
          {SYSTEM_VIEWS.map((item) => (
            <CommandItem
              key={item.view.kind}
              value={`go ${item.title}`}
              onSelect={run(() => onView(item.view))}
            >
              <item.icon />
              {item.title}
              <CommandShortcut>{item.keys}</CommandShortcut>
            </CommandItem>
          ))}
          {labels
            .filter((l) => l.kind === 'user' && l.name !== SNOOZED_LABEL)
            .map((l) => (
              <CommandItem
                key={l.id}
                value={`label ${l.name}`}
                onSelect={run(() => onView({ kind: 'label', labelId: l.id }))}
              >
                <Tag />
                {l.name}
              </CommandItem>
            ))}
        </CommandGroup>
        <CommandGroup heading="Accounts">
          <CommandItem value="account all" onSelect={run(() => onAccount(null))}>
            <Users />
            All accounts
            <CommandShortcut>⌘0</CommandShortcut>
          </CommandItem>
          {accounts.map((a, i) => (
            <CommandItem
              key={a.id}
              value={`account ${a.address}`}
              onSelect={run(() => onAccount(a.id))}
            >
              <Users />
              {a.address}
              {i < 9 && <CommandShortcut>⌘{i + 1}</CommandShortcut>}
            </CommandItem>
          ))}
        </CommandGroup>
        <CommandGroup heading="App">
          <CommandItem value="sync now refresh" onSelect={run(() => void window.amc.syncNow())}>
            <RefreshCw />
            Sync now
          </CommandItem>
          <CommandItem value="toggle theme dark light" onSelect={run(onToggleTheme)}>
            {dark ? <Sun /> : <Moon />}
            {dark ? 'Light mode' : 'Dark mode'}
          </CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  )
}
