import type { AccountSummary } from '@amc/protocol'
import { useId } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { useReplicaState } from '@/hooks/use-amc'
import { failureText } from '@/lib/failure'
import { accountsQuery, queryFailed } from '../mailbox/mailbox-queries'
import {
  type AvatarShape,
  avatarShapes,
  setAccountAvatarShape,
  useAccountAvatarShape,
} from './account-avatar-shape'

const choices = Object.keys(avatarShapes) as AvatarShape[]

export function AccountAvatarSettings() {
  const heading = useId()
  const { snapshot: accounts, refresh } = useReplicaState(accountsQuery())

  return (
    <section className="grid gap-2 border-t pt-4" aria-labelledby={heading}>
      <h3 id={heading} className="text-sm font-medium">
        Account avatar shapes
      </h3>
      <p className="text-xs text-muted-foreground">
        Choose a silhouette for each receiving account. Changes save on this Mac.
      </p>
      {accounts.data?.length ? (
        accounts.data.map((account) => <AccountShapePicker key={account.id} account={account} />)
      ) : (
        <div className="flex items-center justify-between gap-2">
          <output className="text-xs text-muted-foreground">
            {queryFailed(accounts)
              ? 'Could not load accounts.'
              : accounts.data
                ? 'No connected accounts.'
                : 'Loading accounts…'}
          </output>
          {queryFailed(accounts) && (
            <Button type="button" size="sm" variant="outline" onClick={refresh}>
              Retry accounts
            </Button>
          )}
        </div>
      )}
    </section>
  )
}

function AccountShapePicker({ account }: { account: AccountSummary }) {
  const group = useId()
  const shape = useAccountAvatarShape(account.id)
  const name = account.displayName?.trim()
  return (
    <fieldset className="min-w-0 border-b pb-2 last:border-b-0 last:pb-0">
      <legend className="w-full break-all text-xs font-medium">
        {name && name !== account.address ? (
          <>
            {name}
            <span className="block font-normal text-muted-foreground">{account.address}</span>
          </>
        ) : (
          account.address
        )}
      </legend>
      <div className="mt-1.5 grid grid-cols-5 gap-1">
        {choices.map((choice) => (
          <label key={choice} className="relative min-w-0 cursor-pointer">
            <input
              type="radio"
              name={group}
              value={choice}
              checked={shape === choice}
              className="peer sr-only"
              onChange={() => {
                try {
                  setAccountAvatarShape(account.id, choice)
                } catch (error) {
                  toast.error('Could not save avatar shape', { description: failureText(error) })
                }
              }}
            />
            <span className="flex min-h-12 flex-col items-center justify-center gap-1 rounded-md border border-transparent px-0.5 text-center text-[10px] text-muted-foreground peer-checked:border-ring peer-checked:bg-accent peer-checked:text-foreground peer-focus-visible:outline-2 peer-focus-visible:outline-offset-1 peer-focus-visible:outline-ring hover:bg-muted">
              <span
                aria-hidden
                className="size-4 bg-foreground"
                style={avatarShapes[choice].style}
              />
              {avatarShapes[choice].label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}
