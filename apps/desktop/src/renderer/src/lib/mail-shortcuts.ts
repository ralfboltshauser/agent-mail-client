export const mailShortcuts = {
  focusReader: 'o',
  escape: 'escape',
  compose: 'c',
  reply: 'r',
  replyAll: 'a',
  forward: 'f',
  handOff: 'shift+t',
  copyThreadReference: 'mod+shift+c',
  bucket: 'b',
  filterMail: '/',
  searchMail: 'mod+f',
} as const

export function shortcutLabel(binding: string): string {
  if (binding === 'escape') return 'Esc'
  return binding.replace('mod+', '⌘').replace('shift+', '⇧').toUpperCase()
}

export function ariaShortcut(binding: string): string {
  if (binding === 'escape') return 'Escape'
  return binding
    .replace('mod+', 'Meta+')
    .replace('shift+', 'Shift+')
    .replace(/.$/, (key) => key.toUpperCase())
}

// A tooltip can dismiss on Escape without claiming the mailbox command.
export const tooltipDismissals = new WeakSet<KeyboardEvent>()
