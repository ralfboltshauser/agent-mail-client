import { BUCKETS, type Bucket } from '@amc/protocol'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export function BucketPicker({
  current,
  open,
  onOpenChange,
  onSelect,
}: {
  current: Bucket | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (bucket: Bucket | null) => void
}) {
  return (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="sm" className="app-no-drag ml-auto" aria-keyshortcuts="B">
          {current ?? 'Bucket'}
          <ChevronDown />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        onKeyDownCapture={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey || event.repeat) return
          const bucket = BUCKETS[Number(event.key) - 1]
          if (!bucket) return
          event.preventDefault()
          event.stopPropagation()
          onOpenChange(false)
          onSelect(bucket)
        }}
      >
        <DropdownMenuRadioGroup value={current ?? 'none'}>
          {BUCKETS.map((bucket, index) => (
            <DropdownMenuRadioItem key={bucket} value={bucket} onSelect={() => onSelect(bucket)}>
              {bucket}
              <DropdownMenuShortcut>{index + 1}</DropdownMenuShortcut>
            </DropdownMenuRadioItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuRadioItem value="none" onSelect={() => onSelect(null)}>
            Clear Bucket
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
