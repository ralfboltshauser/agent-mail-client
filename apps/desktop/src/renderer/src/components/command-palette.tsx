import { type AccountSummary, BUCKETS, type Label } from '@amc/protocol'
import {
  Layers,
  type LucideIcon,
  Moon,
  RefreshCw,
  Search,
  Sun,
  Tag,
  Undo2,
  Users,
} from 'lucide-react'
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
import { getAmc } from '@/lib/amc'
import type { View } from '../../../shared/api'
import { navigableLabels, systemViews } from './app-sidebar'
import { Kbd } from './ui/kbd'

interface CommandAction {
  name: string
  shortcut?: string
  icon: LucideIcon
  run: () => void
}

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
  snoozeEnabled: boolean
  organise: CommandAction[]
  actions: CommandAction[]
  appActions: CommandAction[]
  onCloseAutoFocus: (event: Event) => void
  undo?: (() => void) | undefined
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
  snoozeEnabled,
  organise,
  actions,
  appActions,
  onCloseAutoFocus,
  undo,
}: Props) {
  const [query, setQuery] = useState('')
  const run = (fn: () => void) => () => {
    onOpenChange(false)
    setQuery('')
    fn()
  }
  const renderAction = (item: CommandAction) => (
    <CommandItem key={item.name} value={item.name} onSelect={run(item.run)}>
      <item.icon />
      {item.name}
      {item.shortcut && <CommandShortcut>{item.shortcut}</CommandShortcut>}
    </CommandItem>
  )
  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery('')
        onOpenChange(next)
      }}
      onCloseAutoFocus={onCloseAutoFocus}
      title="Command palette"
      description="Run an action, switch views or search all mail."
      showCloseButton={false}
    >
      <CommandInput
        placeholder="Type a command or search mail…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList className="max-h-[min(26rem,60dvh)] p-1.5">
        <CommandEmpty>No commands found.</CommandEmpty>
        {actions.length > 0 && (
          <CommandGroup heading="Message">{actions.map(renderAction)}</CommandGroup>
        )}
        {(organise.length > 0 || undo) && (
          <CommandGroup heading="Organise">
            {organise.map(renderAction)}
            {undo && (
              <CommandItem value="undo organise" onSelect={run(undo)}>
                <Undo2 />
                Undo
                <CommandShortcut>Z</CommandShortcut>
              </CommandItem>
            )}
          </CommandGroup>
        )}
        <CommandGroup heading="Go to">
          {systemViews(snoozeEnabled).map((item) => (
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
          {navigableLabels(labels, accounts).map((l) => (
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
        <CommandGroup heading="Buckets">
          {BUCKETS.map((bucket) => (
            <CommandItem
              key={bucket}
              value={`go to bucket ${bucket}`}
              onSelect={run(() => onView({ kind: 'bucket', bucket }))}
            >
              <Layers />
              {bucket}
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
          {appActions.map(renderAction)}
          <CommandItem value="sync now refresh" onSelect={run(() => void getAmc().syncNow())}>
            <RefreshCw />
            Sync now
          </CommandItem>
          <CommandItem value="toggle theme dark light" onSelect={run(onToggleTheme)}>
            {dark ? <Sun /> : <Moon />}
            {dark ? 'Light mode' : 'Dark mode'}
          </CommandItem>
        </CommandGroup>
        {query.trim() && (
          <CommandGroup heading="Search all mail">
            <CommandItem
              value={`search ${query.trim()}`}
              onSelect={run(() => onSearch(query.trim()))}
            >
              <Search />
              Search for “{query.trim()}”
            </CommandItem>
          </CommandGroup>
        )}
      </CommandList>
      <div className="flex items-center gap-3 border-t px-4 py-2 text-xs text-muted-foreground">
        <span>
          <Kbd>↑</Kbd> <Kbd>↓</Kbd> Navigate
        </span>
        <span>
          <Kbd>↵</Kbd> Select
        </span>
        <span className="ml-auto">
          <Kbd>esc</Kbd> Close
        </span>
      </div>
    </CommandDialog>
  )
}
