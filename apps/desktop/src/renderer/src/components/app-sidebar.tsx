import { type AccountSummary, BUCKETS, type Label, SCREENED_OUT_LABEL } from '@amc/protocol'
import {
  Activity,
  Archive,
  ChevronsUpDown,
  CircleHelp,
  Clock3,
  FileText,
  Inbox,
  Layers,
  Mail,
  Search,
  Send,
  SquarePen,
  Star,
  Tag,
  Trash2,
} from 'lucide-react'
import amcMark from '@/assets/amc-mark.png'
import { ActionHint } from '@/components/action-hint'
import { Button } from '@/components/ui/button'
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
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { shareReply } from '@/data/share-reply'
import { accountsQuery, countsQuery, labelsQuery } from '@/features/mailbox/mailbox-queries'
import { useReplicaSelector } from '@/hooks/use-amc'
import { mailShortcuts, shortcutLabel } from '@/lib/mail-shortcuts'
import { cn } from '@/lib/utils'
import type { Counts, View } from '../../../shared/api'
import { SidebarDisclosure } from './sidebar-disclosure'
import { SyncIndicator } from './sync-indicator'
import { SidebarTriage } from './triage-status'
import { Kbd } from './ui/kbd'

const NO_LABELS: Label[] = []

const SYSTEM_VIEWS: { view: View; title: string; icon: typeof Inbox; keys: string }[] = [
  { view: { kind: 'inbox' }, title: 'Inbox', icon: Inbox, keys: 'G I' },
  { view: { kind: 'unread' }, title: 'Unread', icon: Mail, keys: 'G U' },
  { view: { kind: 'starred' }, title: 'Starred', icon: Star, keys: 'G S' },
  { view: { kind: 'drafts' }, title: 'Drafts', icon: FileText, keys: 'G D' },
  { view: { kind: 'outbox' }, title: 'Outbox', icon: Clock3, keys: 'G O' },
  { view: { kind: 'sent' }, title: 'Sent', icon: Send, keys: 'G T' },
  { view: { kind: 'all' }, title: 'All Mail', icon: Archive, keys: 'G A' },
  { view: { kind: 'snoozed' }, title: 'Snoozed', icon: Clock3, keys: 'G H' },
  { view: { kind: 'trash' }, title: 'Trash', icon: Trash2, keys: 'G X' },
]

export function systemViews(snoozeEnabled: boolean) {
  return snoozeEnabled ? SYSTEM_VIEWS : SYSTEM_VIEWS.filter(({ view }) => view.kind !== 'snoozed')
}

export function sameView(a: View, b: View): boolean {
  if (a.kind === 'bucket') return b.kind === 'bucket' && a.bucket === b.bucket
  return (
    a.kind === b.kind && (a.kind !== 'label' || (b.kind === 'label' && a.labelId === b.labelId))
  )
}

export function navigableLabels(
  labels: Label[],
  accounts: Pick<AccountSummary, 'id' | 'kind'>[],
): Label[] {
  const imapAccounts = new Set(
    accounts.filter((account) => account.kind === 'imap').map((account) => account.id),
  )
  return labels.filter((label) =>
    imapAccounts.has(label.accountId)
      ? label.kind === 'user' || !['INBOX', 'SENT', 'DRAFT'].includes(label.providerId)
      : label.kind === 'user',
  )
}

interface Props {
  accountId: string | null
  onAccount: (id: string | null) => void
  view: View
  onView: (view: View) => void
  onCompose: () => void
  onPalette: () => void
  onShortcuts: () => void
  onAgent: () => void
  composing: boolean
  snoozeEnabled: boolean
  obscured?: boolean
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

function AllAccountsBadge({ className }: { className: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('shrink-0 bg-foreground mask-contain mask-center mask-no-repeat', className)}
      style={{ maskImage: `url("${amcMark}")` }}
    />
  )
}

export function AppSidebar({
  accountId,
  onAccount,
  view,
  onView,
  onCompose,
  onPalette,
  onShortcuts,
  onAgent,
  composing,
  snoozeEnabled,
  obscured = false,
}: Props) {
  const { open } = useSidebar()
  const accounts = useReplicaSelector(
    accountsQuery(),
    ({ data }) => data?.map(({ id, address, kind }) => ({ id, address, kind })) ?? [],
    (left, right) => shareReply(left, right) === left,
  )
  const labels = useReplicaSelector(labelsQuery(accountId), ({ data }) => data ?? NO_LABELS)
  const current = accounts.find((a) => a.id === accountId) ?? null
  const folderLabels = navigableLabels(labels, accounts).sort((a, b) => {
    const name = (label: Label) => (label.managed === 'filtered' ? SCREENED_OUT_LABEL : label.name)
    return name(a).localeCompare(name(b)) || Number(!!a.managed) - Number(!!b.managed)
  })

  if (!open) return null
  return (
    <Sidebar
      variant="sidebar"
      collapsible="none"
      inert={obscured}
      className={cn('app-sidebar border-r border-sidebar-border', obscured && 'invisible')}
    >
      {/* Room for the macOS traffic lights; the strip drags the window. */}
      <div className="app-drag h-11 shrink-0" />
      <SidebarHeader className="pt-0">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" className="data-[state=open]:bg-sidebar-accent">
              {current ? (
                <AccountBadge text={current.address} />
              ) : (
                <AllAccountsBadge className="size-7" />
              )}
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
              <AllAccountsBadge className="size-5" />
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
        <ActionHint label="Compose" shortcuts={[mailShortcuts.compose]}>
          <Button
            className="mt-1 h-9 justify-start px-3 shadow-none"
            size="sm"
            onClick={onCompose}
            disabled={composing}
          >
            <SquarePen /> Compose
            <Kbd
              aria-hidden="true"
              className="ml-auto bg-primary-foreground/15 text-primary-foreground"
            >
              {shortcutLabel(mailShortcuts.compose)}
            </Kbd>
          </Button>
        </ActionHint>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {systemViews(snoozeEnabled).map((item) => (
                <SidebarMenuItem key={item.view.kind}>
                  <SidebarMenuButton
                    isActive={sameView(view, item.view)}
                    aria-current={sameView(view, item.view) ? 'page' : undefined}
                    onClick={() => onView(item.view)}
                    tooltip={`${item.title} (${item.keys})`}
                  >
                    <item.icon />
                    <span>{item.title}</span>
                  </SidebarMenuButton>
                  {(item.view.kind === 'inbox' || item.view.kind === 'drafts') && (
                    <CountBadge
                      accountId={accountId}
                      field={item.view.kind === 'inbox' ? 'inboxUnread' : 'drafts'}
                    />
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarDisclosure title="Triage">
          <SidebarTriage accountId={accountId} />
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              {BUCKETS.map((bucket) => {
                const next: View = { kind: 'bucket', bucket }
                return (
                  <SidebarMenuItem key={bucket}>
                    <SidebarMenuButton
                      isActive={sameView(view, next)}
                      aria-current={sameView(view, next) ? 'page' : undefined}
                      onClick={() => onView(next)}
                    >
                      <Layers className="text-muted-foreground" />
                      <span>{bucket}</span>
                    </SidebarMenuButton>
                    <BucketCountBadge accountId={accountId} bucket={bucket} />
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarDisclosure>

        {folderLabels.length > 0 && (
          <SidebarDisclosure title="Labels">
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5">
                {folderLabels.map((label) => {
                  const v: View = { kind: 'label', labelId: label.id }
                  return (
                    <SidebarMenuItem key={label.id}>
                      <SidebarMenuButton isActive={sameView(view, v)} onClick={() => onView(v)}>
                        <Tag style={label.color ? { color: label.color } : undefined} />
                        <span className="truncate">
                          {label.managed === 'filtered' ? 'Filtered' : label.name}
                        </span>
                        {label.managed === 'filtered' && (
                          <FilteredCount accountId={accountId} labelId={label.id} />
                        )}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  )
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarDisclosure>
        )}
      </SidebarContent>

      <SidebarFooter className="gap-1 border-t border-sidebar-border pt-2">
        <SidebarMenu className="gap-0.5">
          <SidebarMenuItem>
            <SidebarMenuButton onClick={onAgent}>
              <Activity />
              Agent activity
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={onPalette}>
              <Search />
              Search &amp; Ask<Kbd className="ml-auto">⌘K</Kbd>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton onClick={onShortcuts}>
              <CircleHelp />
              Keyboard shortcuts<Kbd className="ml-auto">?</Kbd>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <SyncIndicator />
      </SidebarFooter>
    </Sidebar>
  )
}

function CountBadge({
  accountId,
  field,
}: {
  accountId: string | null
  field: 'inboxUnread' | 'drafts'
}) {
  const count = useReplicaSelector(countsQuery(accountId), ({ data }) => data?.[field] ?? 0)
  return count > 0 ? <SidebarMenuBadge className="tabular-nums">{count}</SidebarMenuBadge> : null
}

function BucketCountBadge({
  accountId,
  bucket,
}: {
  accountId: string | null
  bucket: keyof Counts['buckets']
}) {
  const count = useReplicaSelector(countsQuery(accountId), ({ data }) => data?.buckets[bucket])
  return <SidebarMenuBadge className="tabular-nums">{count?.toLocaleString()}</SidebarMenuBadge>
}

function FilteredCount({ accountId, labelId }: { accountId: string | null; labelId: string }) {
  const count = useReplicaSelector(
    countsQuery(accountId),
    ({ data }) => data?.filteredByLabel?.[labelId] ?? 0,
  )
  return <span className="ml-auto tabular-nums text-muted-foreground">{count}</span>
}
