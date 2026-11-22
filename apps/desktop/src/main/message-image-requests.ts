import type { Session } from 'electron'

export function protectRemoteImageRequests(session: Session) {
  // Message srcdoc frames inherit the renderer's CSP. Its img-src permits HTTP(S) so a
  // message can opt in, while this filter preserves the renderer's local-only image policy.
  session.webRequest.onBeforeRequest(
    { urls: ['https://*/*', 'http://*/*'] },
    (request, respond) => {
      const isRemoteImage = request.resourceType === 'image'
      const isMessageFrame = request.frame?.url === 'about:srcdoc' && request.frame.parent !== null
      respond({ cancel: isRemoteImage && !isMessageFrame })
    },
  )
}
