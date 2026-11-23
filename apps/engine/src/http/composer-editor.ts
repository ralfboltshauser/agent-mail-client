import { COMPOSER_FIELD, composeStarterKit, InlineImage } from '@amc/composer'
import { HocuspocusProvider } from '@hocuspocus/provider'
import { Editor } from '@tiptap/core'
import Collaboration from '@tiptap/extension-collaboration'
import * as Y from 'yjs'

const status = document.querySelector<HTMLElement>('#status')
const element = document.querySelector<HTMLElement>('#editor')
const id = decodeURIComponent(location.pathname.split('/').at(-1) ?? '')
const token = new URLSearchParams(location.hash.slice(1)).get('token')
if (location.hash) history.replaceState(null, '', location.pathname)

async function start() {
  if (!status || !element) return
  const session =
    token &&
    (await fetch(`${location.pathname}/session`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      // The page displays the unusable-link state for network and authorization failures.
    }).catch(() => null))
  if (!session || !session.ok || !token) {
    status.textContent = 'Open a valid Composer Link to edit this draft.'
    return
  }

  const doc = new Y.Doc()
  let editor: Editor | undefined
  const url = new URL('/compose/ws', location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  const provider = new HocuspocusProvider({
    url: url.href,
    name: id,
    document: doc,
    token,
    awareness: null,
    onSynced: ({ state }) => {
      if (!state) return
      editor ??= new Editor({
        element,
        extensions: [
          composeStarterKit,
          InlineImage,
          Collaboration.configure({ document: doc, field: COMPOSER_FIELD }),
        ],
        injectCSS: false,
        editable: false,
        editorProps: {
          attributes: { 'aria-label': 'Reply body', role: 'textbox', 'aria-multiline': 'true' },
        },
      })
      status.textContent = 'Draft synced to AMC'
      editor.setEditable(true)
    },
    onUnsyncedChanges: ({ number }) => {
      if (editor?.isEditable) status.textContent = number ? 'Saving…' : 'Draft synced to AMC'
    },
    onDisconnect: ({ event }) => {
      editor?.setEditable(false)
      if (event.code === 4400 || event.code === 4403) {
        status.textContent =
          event.reason || 'Editing ended. Reopen your Composer Link to try again.'
        provider.disconnect()
      } else {
        status.textContent = 'Reconnecting…'
      }
    },
    onClose: ({ event }) => {
      if (!event.reason) return
      editor?.setEditable(false)
      status.textContent = event.reason || 'Editing ended. Reopen your Composer Link to try again.'
    },
    onAuthenticationFailed: () => {
      editor?.setEditable(false)
      status.textContent = 'This Composer Link is no longer available.'
      provider.disconnect()
    },
  })
}

void start()
