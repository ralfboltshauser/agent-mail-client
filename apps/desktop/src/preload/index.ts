import { contextBridge, ipcRenderer } from 'electron'
import type { AmcApi, SyncStatus } from '../shared/api'

const invoke =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(`amc:${channel}`, ...args)

const api: AmcApi = {
  pair: invoke('pair') as AmcApi['pair'],
  unpair: invoke('unpair') as AmcApi['unpair'],
  status: invoke('status') as AmcApi['status'],
  syncNow: invoke('syncNow') as AmcApi['syncNow'],
  organise: invoke('organise') as AmcApi['organise'],
  organiseErrors: invoke('organiseErrors') as AmcApi['organiseErrors'],
  accounts: invoke('accounts') as AmcApi['accounts'],
  labels: invoke('labels') as AmcApi['labels'],
  counts: invoke('counts') as AmcApi['counts'],
  threads: invoke('threads') as AmcApi['threads'],
  thread: invoke('thread') as AmcApi['thread'],
  summaries: invoke('summaries') as AmcApi['summaries'],
  filter: invoke('filter') as AmcApi['filter'],
  search: invoke('search') as AmcApi['search'],
  contacts: invoke('contacts') as AmcApi['contacts'],
  messageHtml: invoke('messageHtml') as AmcApi['messageHtml'],
  openAttachment: invoke('openAttachment') as AmcApi['openAttachment'],
  openExternal: invoke('openExternal') as AmcApi['openExternal'],
  onStatus(listener) {
    const handler = (_e: unknown, status: SyncStatus) => listener(status)
    ipcRenderer.on('amc:status', handler)
    return () => ipcRenderer.off('amc:status', handler)
  },
  onChanged(listener) {
    const handler = () => listener()
    ipcRenderer.on('amc:changed', handler)
    return () => ipcRenderer.off('amc:changed', handler)
  },
}

contextBridge.exposeInMainWorld('amc', api)
