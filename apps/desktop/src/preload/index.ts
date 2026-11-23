import { newRequestId, RENDERER_LOG_CHANNEL, type RendererLogReport } from '@amc/observability'
import type { ComposePatch, ThreadSummary } from '@amc/protocol'
import { contextBridge, ipcRenderer } from 'electron'
import type { AmcApi, ReviewApi, SmartInboxApi, SyncStatus } from '../shared/api'
import { failureDetails, formatFailure, readFailure, rendererReport } from '../shared/failure'

// One in-flight report and a small queue bound memory and IPC pressure in a failing window.
const reports: RendererLogReport[] = []
let reporting = false
async function drainReports() {
  reporting = true
  try {
    for (let report = reports.shift(); report; report = reports.shift()) {
      await ipcRenderer.invoke(RENDERER_LOG_CHANNEL, report)
    }
  } catch {
    // The reporting channel can disappear during a renderer reload.
    reports.length = 0
  } finally {
    reporting = false
  }
}

function reportFailure(value: RendererLogReport) {
  if (!process.isMainFrame || reports.length >= 16) return
  const report = rendererReport(value)
  if (!report) return
  reports.push(report)
  if (!reporting) void drainReports()
}

function ipcRejection(error: unknown) {
  const known = readFailure(error)
  const details = known ?? failureDetails(error, newRequestId(), 'Request')
  reportFailure({
    source: 'ipc.rejected',
    errorClass: details.errorClass,
    ...(details.kind === 'Run'
      ? { runId: details.id as RendererLogReport['runId'] }
      : { requestId: details.id as RendererLogReport['requestId'] }),
  })
  return known ? error : new Error(formatFailure(details))
}

const invoke =
  (channel: string, preserveError = false) =>
  (...args: unknown[]) =>
    ipcRenderer.invoke(`amc:${channel}`, ...args).catch((error: unknown) => {
      const failure = ipcRejection(error)
      throw preserveError ? error : failure
    })

const api: AmcApi = {
  reportFailure,
  logSettings: invoke('logSettings') as AmcApi['logSettings'],
  setDebugLogging: invoke('setDebugLogging') as AmcApi['setDebugLogging'],
  feedback: {
    onOpen(listener) {
      const handler = () => listener()
      ipcRenderer.on('amc:feedbackOpen', handler)
      ipcRenderer.send('amc:feedbackReady')
      return () => ipcRenderer.off('amc:feedbackOpen', handler)
    },
    capture: invoke('feedbackCapture', true) as AmcApi['feedback']['capture'],
    send: invoke('feedbackSend', true) as AmcApi['feedback']['send'],
    release: invoke('feedbackRelease', true) as AmcApi['feedback']['release'],
    copy: invoke('feedbackCopy', true) as AmcApi['feedback']['copy'],
  },
  smartInbox: {
    review: {
      reviewPairing: invoke('reviewPairing') as ReviewApi['reviewPairing'],
      reviewBucket: invoke('reviewBucket') as ReviewApi['reviewBucket'],
      reviewOrganise: invoke('reviewOrganise') as ReviewApi['reviewOrganise'],
      reviewOrganiseStatus: invoke('reviewOrganiseStatus') as ReviewApi['reviewOrganiseStatus'],
    },
    listSenders: invoke('listSenders') as SmartInboxApi['listSenders'],
    decideSender: invoke('decideSender') as SmartInboxApi['decideSender'],
    reviewFilter: invoke('reviewFilter') as NonNullable<SmartInboxApi['reviewFilter']>,
    filterThread: invoke('filterThread') as NonNullable<SmartInboxApi['filterThread']>,
    restoreFiltered: invoke('restoreFiltered') as NonNullable<SmartInboxApi['restoreFiltered']>,
    editOwnerReason: invoke('editOwnerReason') as NonNullable<SmartInboxApi['editOwnerReason']>,
    adoptScreenedDestination: invoke(
      'adoptScreenedDestination',
    ) as SmartInboxApi['adoptScreenedDestination'],
    ownerAction: invoke('ownerAction') as SmartInboxApi['ownerAction'],
    undoOwnerAction: invoke('undoOwnerAction') as SmartInboxApi['undoOwnerAction'],
    triageHistory: invoke('triageHistory') as SmartInboxApi['triageHistory'],
    forgetTriageDecision: invoke('forgetTriageDecision') as SmartInboxApi['forgetTriageDecision'],
    exportTriageHistory: invoke('exportTriageHistory') as SmartInboxApi['exportTriageHistory'],
    triageQueue: invoke('triageQueue') as SmartInboxApi['triageQueue'],
    resolveSenderAvatars: invoke('resolveSenderAvatars') as SmartInboxApi['resolveSenderAvatars'],
  },
  notificationSettings: invoke('notificationSettings') as AmcApi['notificationSettings'],
  saveNotificationSettings: invoke(
    'saveNotificationSettings',
  ) as AmcApi['saveNotificationSettings'],
  onOpenSettings(listener) {
    const handler = () => listener()
    ipcRenderer.on('amc:openSettings', handler)
    return () => ipcRenderer.off('amc:openSettings', handler)
  },
  onOpenThread(listener) {
    const handler = (_e: unknown, thread: ThreadSummary) => listener(thread)
    ipcRenderer.on('amc:openThread', handler)
    ipcRenderer.send('amc:threadNavigationReady')
    return () => ipcRenderer.off('amc:openThread', handler)
  },
  triageStatus: invoke('triageStatus') as AmcApi['triageStatus'],
  setAutoTriage: invoke('setAutoTriage') as AmcApi['setAutoTriage'],
  triageCounts: invoke('triageCounts') as AmcApi['triageCounts'],
  triageNow: invoke('triageNow') as AmcApi['triageNow'],
  onTriageStatus(listener) {
    const handler = (_e: unknown, status: Awaited<ReturnType<AmcApi['triageStatus']>>) =>
      listener(status)
    ipcRenderer.on('amc:triageStatus', handler)
    return () => ipcRenderer.off('amc:triageStatus', handler)
  },
  t3Setup: invoke('t3Setup') as AmcApi['t3Setup'],
  t3Projects: invoke('t3Projects') as AmcApi['t3Projects'],
  handoff: invoke('handoff') as AmcApi['handoff'],
  cancelHandoff: invoke('cancelHandoff') as AmcApi['cancelHandoff'],
  activeHandoff: invoke('activeHandoff') as AmcApi['activeHandoff'],
  endHandoff: invoke('endHandoff') as AmcApi['endHandoff'],
  pair: invoke('pair') as AmcApi['pair'],
  retrySavedPairing: invoke('retrySavedPairing') as AmcApi['retrySavedPairing'],
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
    if (error) throw ipcRejection(new Error(error))
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
  cachedMessageHtml: invoke('cachedMessageHtml') as AmcApi['cachedMessageHtml'],
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
