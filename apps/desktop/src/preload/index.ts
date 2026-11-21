import type { ComposePatch } from '@amc/protocol'
import { contextBridge, ipcRenderer } from 'electron'
import type { AmcApi, SyncStatus } from '../shared/api'

const invoke =
  (channel: string) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(`amc:${channel}`, ...args)

const api: AmcApi = {
  savedT3Url: invoke('savedT3Url') as AmcApi['savedT3Url'],
  t3Projects: invoke('t3Projects') as AmcApi['t3Projects'],
  handoff: invoke('handoff') as AmcApi['handoff'],
  cancelHandoff: invoke('cancelHandoff') as AmcApi['cancelHandoff'],
  activeHandoff: invoke('activeHandoff') as AmcApi['activeHandoff'],
  endHandoff: invoke('endHandoff') as AmcApi['endHandoff'],
  pair: invoke('pair') as AmcApi['pair'],
  unpair: invoke('unpair') as AmcApi['unpair'],
  status: invoke('status') as AmcApi['status'],
  syncNow: invoke('syncNow') as AmcApi['syncNow'],
  setBucket: invoke('setBucket') as AmcApi['setBucket'],
  organise: invoke('organise') as AmcApi['organise'],
  organiseErrors: invoke('organiseErrors') as AmcApi['organiseErrors'],
  agentActivity: invoke('agentActivity') as AmcApi['agentActivity'],
  undoAgentAction: invoke('undoAgentAction') as AmcApi['undoAgentAction'],
  accounts: invoke('accounts') as AmcApi['accounts'],
  labels: invoke('labels') as AmcApi['labels'],
  counts: invoke('counts') as AmcApi['counts'],
  threads: invoke('threads') as AmcApi['threads'],
  thread: invoke('thread') as AmcApi['thread'],
  summaries: invoke('summaries') as AmcApi['summaries'],
  filter: invoke('filter') as AmcApi['filter'],
  search: invoke('search') as AmcApi['search'],
  contacts: invoke('contacts') as AmcApi['contacts'],
  startCompose: invoke('startCompose') as AmcApi['startCompose'],
  composeDrafts: invoke('composeDrafts') as AmcApi['composeDrafts'],
  composeDraft: invoke('composeDraft') as AmcApi['composeDraft'],
  discardDraft: invoke('discardDraft') as AmcApi['discardDraft'],
  stageComposeBody(id: string, patch: ComposePatch) {
    const error = ipcRenderer.sendSync('amc:stageComposeBody', id, patch)
    if (error) throw new Error(error)
  },
  saveCompose: invoke('saveCompose') as AmcApi['saveCompose'],
  addComposeAttachment: invoke('addComposeAttachment') as AmcApi['addComposeAttachment'],
  composeImage: invoke('composeImage') as AmcApi['composeImage'],
  sendDraft: invoke('sendDraft') as AmcApi['sendDraft'],
  outbox: invoke('outbox') as AmcApi['outbox'],
  resolveSend: invoke('resolveSend') as AmcApi['resolveSend'],
  cancelSend: invoke('cancelSend') as AmcApi['cancelSend'],
  signature: invoke('signature') as AmcApi['signature'],
  saveSignature: invoke('saveSignature') as AmcApi['saveSignature'],
  sendSettings: invoke('sendSettings') as AmcApi['sendSettings'],
  saveSendSettings: invoke('saveSendSettings') as AmcApi['saveSendSettings'],
  messageText: invoke('messageText') as AmcApi['messageText'],
  messageHtml: invoke('messageHtml') as AmcApi['messageHtml'],
  inlineAttachment: invoke('inlineAttachment') as AmcApi['inlineAttachment'],
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
