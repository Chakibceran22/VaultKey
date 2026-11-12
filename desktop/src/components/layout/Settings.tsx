import { useState } from 'react'
import { Tabs } from '@base-ui/react/tabs'
import { Button } from '@renderer/components/ui/button'
import { Modal, ModalFooter } from '@renderer/components/ui/overlays'
import { BackgroundPanel } from './Background'
import { BrowserExtensionPanel } from './BrowserExtension'

type Tab = 'extension' | 'background'

const tabClass =
  'flex h-7 cursor-pointer items-center rounded-md px-3 text-[13px] font-medium text-muted-foreground outline-none transition-[color,background-color,box-shadow] duration-150 hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring data-active:bg-white data-active:text-heading data-active:shadow-[0_1px_2px_rgb(30_34_70/0.07)] dark:data-active:bg-white/12 dark:data-active:shadow-none'

/**
 * Settings (the gear in the top bar, or ⌘,): the browser extension, and background mode
 * with auto-lock. One modal, a tab each; the tab stays where it was left while the app
 * runs. Each panel loads its own data when it's shown.
 */
export function Settings({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [tab, setTab] = useState<Tab>('extension')
  return (
    <Modal open={open} onOpenChange={onOpenChange} size="lg" title="Settings">
      {open && (
        <>
          <Tabs.Root
            value={tab}
            onValueChange={(value: Tab) => setTab(value)}
            className="flex min-h-0 flex-1 flex-col"
          >
            <Tabs.List
              aria-label="Settings"
              className="mx-6 mt-3 inline-flex self-start rounded-lg border bg-secondary/70 p-0.5"
            >
              <Tabs.Tab value="extension" className={tabClass}>
                Browser extension
              </Tabs.Tab>
              <Tabs.Tab value="background" className={tabClass}>
                Background & auto-lock
              </Tabs.Tab>
            </Tabs.List>
            <Tabs.Panel value="extension" className="flex min-h-0 flex-1 flex-col outline-none">
              <BrowserExtensionPanel />
            </Tabs.Panel>
            <Tabs.Panel value="background" className="flex min-h-0 flex-1 flex-col outline-none">
              <BackgroundPanel />
            </Tabs.Panel>
          </Tabs.Root>
          <ModalFooter>
            <Button variant="primary" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </ModalFooter>
        </>
      )}
    </Modal>
  )
}
