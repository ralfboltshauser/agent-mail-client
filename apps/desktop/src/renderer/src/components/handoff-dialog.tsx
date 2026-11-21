import type { ComposeDraft } from '@amc/protocol'
import { useCallback, useEffect, useId, useState } from 'react'
import type { T3Project } from '../../../shared/api'
import { Button } from './ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './ui/dialog'
import { Input } from './ui/input'

export function HandoffDialog({
  threadId,
  onClose,
  onDraft,
}: {
  threadId: string
  onClose: () => void
  onDraft: (draft: ComposeDraft) => void
}) {
  const addressId = useId()
  const projectSelectId = useId()
  const [address, setAddress] = useState('')
  const [projects, setProjects] = useState<T3Project[] | null>(null)
  const [projectId, setProjectId] = useState('')
  const [busy, setBusy] = useState(false)
  const [attempted, setAttempted] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async (url: string) => {
    setBusy(true)
    setError('')
    try {
      const known = await window.amc.t3Projects(url)
      const previous = localStorage.getItem('amc-handoff-project')
      setProjects(known)
      setProjectId(known.find((project) => project.id === previous)?.id ?? known[0]?.id ?? '')
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void window.amc.savedT3Url().then((url) => {
      if (url) {
        setAddress(url)
        void load(url)
      }
    })
  }, [load])

  const launch = async () => {
    if (!projectId) return
    setBusy(true)
    setError('')
    setAttempted(true)
    try {
      const draft = await window.amc.handoff(address.trim(), projectId, threadId)
      localStorage.setItem('amc-handoff-project', projectId)
      onDraft(draft)
    } catch (cause) {
      setError((cause as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const close = async () => {
    if (busy) return
    if (attempted) {
      setBusy(true)
      try {
        await window.amc.cancelHandoff(projectId, threadId)
      } catch (cause) {
        setError((cause as Error).message)
        setBusy(false)
        return
      }
    }
    onClose()
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) void close()
      }}
    >
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Hand off to T3</DialogTitle>
          <DialogDescription>T3 drafts a reply. Review and send it in AMC.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            if (busy) return
            if (projects) void launch()
            else void load(address.trim())
          }}
        >
          {!projects ? (
            <div className="grid gap-2">
              <label htmlFor={addressId} className="text-sm font-medium">
                T3 MCP URL
              </label>
              <Input
                id={addressId}
                type="url"
                required
                value={address}
                disabled={busy}
                onChange={(event) => setAddress(event.target.value)}
              />
              <p className="text-sm text-muted-foreground">
                Copy the MCP URL in T3 Settings → Environments. Approve Supervised access when
                prompted.
              </p>
            </div>
          ) : (
            <div className="grid gap-2">
              <label htmlFor={projectSelectId} className="text-sm font-medium">
                T3 project
              </label>
              <select
                id={projectSelectId}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-ring"
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
                disabled={busy || attempted}
              >
                {projects.length === 0 && <option value="">No projects in this environment</option>}
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.title}
                  </option>
                ))}
              </select>
            </div>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <DialogFooter>
            {projects && !attempted && (
              <Button
                type="button"
                variant="ghost"
                disabled={busy}
                onClick={() => setProjects(null)}
              >
                Change environment
              </Button>
            )}
            <Button type="button" variant="outline" disabled={busy} onClick={() => void close()}>
              Cancel
            </Button>
            <Button disabled={busy || (projects !== null && !projectId)}>
              {projects
                ? busy
                  ? 'Launching…'
                  : 'Hand off'
                : busy
                  ? 'Connecting…'
                  : 'Connect to T3'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
