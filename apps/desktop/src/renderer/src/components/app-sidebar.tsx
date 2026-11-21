import { type AccountSummary, type Label, SNOOZED_LABEL } from '@amc/protocol'
import {
  Archive,
  ChevronsUpDown,
  Clock3,
  FileText,
  Inbox,
  Mail,
  Send,
  Star,
  Tag,
  Trash2,
} from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'
import type { Counts, SyncStatus, View } from '../../../shared/api'
import { SyncIndicator } from './sync-indicator'

export const SYSTEM_VIEWS: { view: View; title: string; icon: typeof Inbox; keys: string }[] = [
  { view: { kind: 'inbox' }, title: 'Inbox', icon: Inbox, keys: 'G I' },
  { view: { kind: 'unread' }, title: 'Unread', icon: Mail, keys: 'G U' },
  { view: { kind: 'starred' }, title: 'Starred', icon: Star, keys: 'G S' },
  { view: { kind: 'drafts' }, title: 'Drafts', icon: FileText, keys: 'G D' },
  { view: { kind: 'sent' }, title: 'Sent', icon: Send, keys: 'G T' },
  { view: { kind: 'all' }, title: 'All Mail', icon: Archive, keys: 'G A' },
  { view: { kind: 'snoozed' }, title: 'Snoozed', icon: Clock3, keys: 'G H' },
  { view: { kind: 'trash' }, title: 'Trash', icon: Trash2, keys: 'G X' },
]

export function sameView(a: View, b: View): boolean {
  return (
    a.kind === b.kind && (a.kind !== 'label' || (b.kind === 'label' && a.labelId === b.labelId))
  )
}

interface Props {
  accounts: AccountSummary[]
  accountId: string | null
  onAccount: (id: string | null) => void
  view: View
  onView: (view: View) => void
  counts: Counts
  labels: Label[]
  status: SyncStatus | null
}

function AccountBadge({ text, className }: { text: string; className?: string }) {
  return (
    <div
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-[11px] font-semibold text-primary-foreground',
        className,
      )}
    >
      {text.slice(0, 1).toUpperCase()}
    </div>
  )
}

export function AppSidebar({
  accounts,
  accountId,
  onAccount,
  view,
  onView,
  counts,
  labels,
  status,
}: Props) {
  const current = accounts.find((a) => a.id === accountId) ?? null
  const userLabels = labels
    .filter((l) => l.kind === 'user' && l.name !== SNOOZED_LABEL)
    .sort((a, b) => a.name.localeCompare(b.name))

  const badge = (kind: View['kind']) => {
    if (kind === 'inbox') return counts.inboxUnread || null
    if (kind === 'drafts') return counts.drafts || null
    return null
  }

  return (
    <Sidebar variant="inset" collapsible="offcanvas">
      {/* Room for the macOS traffic lights; the strip drags the window. */}
      <div className="app-drag h-10 shrink-0" />
      <SidebarHeader className="pt-0">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
              <AccountBadge
                text={current?.address ?? 'All'}
                className={current ? '' : 'bg-foreground text-background'}
              />
              <div className="grid flex-1 text-left leading-tight">
                <span className="truncate text-sm font-medium">
                  {current ? current.address.split('@')[0] : 'All accounts'}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {current
                    ? current.address
                    : `${accounts.length} account${accounts.length === 1 ? '' : 's'}`}
                </span>
              </div>
              <ChevronsUpDown className="ml-auto size-4 text-muted-foreground" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-64" align="start">
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              Accounts
            </DropdownMenuLabel>
            <DropdownMenuItem onSelect={() => onAccount(null)}>
              <AccountBadge text="A" className="size-5 bg-foreground text-[10px] text-background" />
              All accounts
              <DropdownMenuShortcut>⌘0</DropdownMenuShortcut>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {accounts.map((a, i) => (
              <DropdownMenuItem key={a.id} onSelect={() => onAccount(a.id)}>
                <AccountBadge text={a.address} className="size-5 text-[10px]" />
                <span className="truncate">{a.address}</span>
                {i < 9 && <DropdownMenuShortcut>⌘{i + 1}</DropdownMenuShortcut>}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {SYSTEM_VIEWS.map((item) => (
                <SidebarMenuItem key={item.view.kind}>
                  <SidebarMenuButton
                    isActive={sameView(view, item.view)}
                    onClick={() => onView(item.view)}
                    tooltip={`${item.title} (${item.keys})`}
                  >
                    <item.icon />
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                  {badge(item.view.kind) !== null && (
                    <SidebarMenuBadge className="tabular-nums">
                      {badge(item.view.kind)}
                    </SidebarMenuBadge>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {userLabels.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>Labels</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {userLabels.map((label) => {
                  const v: View = { kind: 'label', labelId: label.id }
                  return (
                    <SidebarMenuItem key={label.id}>
                      <SidebarMenuButton isActive={sameView(view, v)} onClick={() => onView(v)}>
                        <Tag style={label.color ? { color: label.color } : undefined} />
                        <span className="truncate">{label.name}</span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter>
        <SyncIndicator status={status} accounts={accounts} />
      </SidebarFooter>
    </Sidebar>
  )
}
