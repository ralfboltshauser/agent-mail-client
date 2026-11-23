import { ChevronRight } from 'lucide-react'
import { Collapsible } from 'radix-ui'
import type { ReactNode } from 'react'
import { SidebarGroup, SidebarGroupLabel } from '@/components/ui/sidebar'

export function SidebarDisclosure({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Collapsible.Root asChild>
      <SidebarGroup className="data-[state=closed]:pb-0">
        <h2>
          <SidebarGroupLabel asChild>
            <Collapsible.Trigger className="group/disclosure w-full justify-between hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
              {title}
              <ChevronRight
                aria-hidden="true"
                className="group-data-[state=open]/disclosure:rotate-90"
              />
            </Collapsible.Trigger>
          </SidebarGroupLabel>
        </h2>
        <Collapsible.Content>{children}</Collapsible.Content>
      </SidebarGroup>
    </Collapsible.Root>
  )
}
