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
import { useEffect, useMemo } from 'react'
import { toast } from 'sonner'
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
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar'
import { replicaStoreFor } from '@/data/replica-store'
import { shareReply } from '@/data/share-reply'
import { accountsQuery, countsQuery, labelsQuery } from '@/features/mailbox/mailbox-queries'
import { useReplicaSelector, useSyncField } from '@/hooks/use-amc'
import { getAmc } from '@/lib/amc'
import { cn } from '@/lib/utils'
import type { Counts, View } from '../../../shared/api'
import { SyncIndicator } from './sync-indicator'
import { LastTriageRun, useTriageStatus } from './triage-status'
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
}: Props) {
  const { open } = useSidebar()
  const triage = useTriageStatus()
  const api = getAmc()
  const triageQuery = useMemo(
    () => ({
      key: JSON.stringify(['triage-counts', accountId]),
      load: () => api.triageCounts(accountId),
    }),
    [api, accountId],
  )
  const triageCounts = useReplicaSelector(triageQuery, ({ data }) => data)
  useEffect(() => {
    const timer = setInterval(() => void replicaStoreFor(api).refresh(triageQuery), 60_000)
    return () => clearInterval(timer)
  }, [api, triageQuery])
  const syncIsLive = useSyncField((status) => status?.phase === 'live')
  const triageDisabled = !syncIsLive || !triage || triage.running
  const accounts = useReplicaSelector(
    accountsQuery(),
    ({ data }) => data?.map(({ id, address, kind }) => ({ id, address, kind })) ?? [],
    (left, right) => shareReply(left, right) === left,
  )
  const labels = useReplicaSelector(labelsQuery(accountId), ({ data }) => data ?? NO_LABELS)
  const runTriage = (scope: 'recent' | 'account') => {
    void getAmc()
      .triageNow(accountId, scope)
      .catch(() => toast.error('Could not start triage.'))
  }
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
      className="app-sidebar border-r border-sidebar-border"
    >
      {/* Room for the macOS traffic lights; the strip drags the window. */}
      <div className="app-drag h-11 shrink-0" />
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
        <Button
          className="mt-1 h-9 justify-start px-3 shadow-none"
          size="sm"
          onClick={onCompose}
          disabled={composing}
        >
          <SquarePen /> Compose{' '}
          <Kbd className="ml-auto bg-primary-foreground/15 text-primary-foreground">C</Kbd>
        </Button>
      </SidebarHeader>

      <SidebarContent className="gap-0">
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

        <SidebarGroup>
          <SidebarGroupLabel>Triage</SidebarGroupLabel>
          {triageCounts && (
            <p className="px-2 pb-1 text-xs text-muted-foreground">
              {triageCounts.recent
                ? `${triageCounts.recent.toLocaleString()} new to triage`
                : 'No new mail to triage'}
              {' · '}
              {triageCounts.older.toLocaleString()} older untriaged
            </p>
          )}
          <div className="flex flex-wrap gap-x-1 px-1">
            <Button
              variant="ghost"
              size="sm"
              disabled={triageDisabled}
              onClick={() => runTriage('recent')}
              title="Triage Inbox Threads delivered in the last 24 hours"
            >
              Triage recent
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={triageDisabled || triageCounts?.older === 0}
              onClick={() => runTriage('account')}
            >
              Triage older…
            </Button>
          </div>
          <LastTriageRun status={triage} />
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
        </SidebarGroup>

        {folderLabels.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>Labels</SidebarGroupLabel>
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
          </SidebarGroup>
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
              Command palette<Kbd className="ml-auto">⌘K</Kbd>
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
