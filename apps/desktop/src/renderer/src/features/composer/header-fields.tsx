import type { AccountSummary, Address } from '@amc/protocol'
import { memo, useId, useState } from 'react'
import { RecipientField } from '@/components/recipient-field'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { DraftSession } from './draft-session'
import { useDraftValue } from './use-draft-value'

export const FromField = memo(function FromField({
  session,
  accounts,
  onAccountChange,
}: {
  session: DraftSession
  accounts: AccountSummary[]
  onAccountChange: (accountId: string) => void
}) {
  const accountId = useDraftValue(session, (draft) => draft.fields.accountId)
  return (
    <label className="grid grid-cols-[3rem_1fr] items-center border-b px-4 py-1.5 text-sm text-muted-foreground">
      From
      <select
        className="h-8 w-full rounded bg-background px-2 text-foreground focus-visible:outline-ring"
        value={accountId}
        onChange={(event) => {
          onAccountChange(event.target.value)
        }}
      >
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>
            {a.address}
          </option>
        ))}
      </select>
    </label>
  )
})

type RecipientKey = 'to' | 'cc' | 'bcc'

const DraftRecipientField = memo(function DraftRecipientField({
  session,
  name,
  label,
}: {
  session: DraftSession
  name: RecipientKey
  label: string
}) {
  const recipients = useDraftValue(session, (draft) => draft.fields[name])
  return (
    <RecipientField
      label={label}
      recipients={recipients}
      onChange={(values: Address[]) => session.updateField(name, values)}
    />
  )
})

export const ComposerRecipients = memo(function ComposerRecipients({
  session,
}: {
  session: DraftSession
}) {
  const [expanded, setExpanded] = useState(
    Boolean(session.fields.cc.length || session.fields.bcc.length),
  )
  const hasExtra = useDraftValue(session, (draft) =>
    Boolean(draft.fields.cc.length || draft.fields.bcc.length),
  )
  // Once shown, keep Cc / Bcc open, including after a remote recipient is removed.
  if (hasExtra && !expanded) setExpanded(true)
  return (
    <>
      <div className="relative">
        <DraftRecipientField session={session} name="to" label="To" />
        {!expanded && (
          <Button
            className="absolute top-1.5 right-3"
            variant="secondary"
            size="xs"
            onClick={() => setExpanded(true)}
          >
            Cc / Bcc
          </Button>
        )}
      </div>
      {expanded && (
        <>
          <DraftRecipientField session={session} name="cc" label="Cc" />
          <DraftRecipientField session={session} name="bcc" label="Bcc" />
        </>
      )}
    </>
  )
})

export const SubjectField = memo(function SubjectField({ session }: { session: DraftSession }) {
  const subject = useDraftValue(session, (draft) => draft.fields.subject)
  const subjectId = useId()
  return (
    <label
      htmlFor={subjectId}
      className="grid grid-cols-[3rem_1fr] items-center border-b px-4 py-1.5 text-sm text-muted-foreground"
    >
      Subject
      <Input
        id={subjectId}
        value={subject}
        onChange={(event) => session.updateField('subject', event.target.value)}
        className="h-8 border-0 bg-transparent text-foreground shadow-none dark:bg-transparent"
        maxLength={998}
      />
    </label>
  )
})
