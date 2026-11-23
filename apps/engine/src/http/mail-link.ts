import { randomBytes } from 'node:crypto'
import { MAIL_LINK_BRIDGE } from '@amc/protocol'
import { Hono } from 'hono'

/** A web URL works in clients that restrict custom schemes in rendered Markdown. */
export function mailLinkRoutes() {
  return new Hono().get(MAIL_LINK_BRIDGE, (c) => {
    const nonce = randomBytes(16).toString('base64')
    c.header(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
    )
    c.header('Referrer-Policy', 'no-referrer')
    c.header('Cache-Control', 'no-store')
    return c.html(`<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Open in AMC</title>
<main>
  <h1>Open in AMC</h1>
  <p id="message">This AMC link is invalid.</p>
  <a id="open" hidden>Open in AMC</a>
</main>
<script nonce="${nonce}">
  try {
    const target = decodeURIComponent(location.hash.slice(1));
    if (/^amc:\\/\\/(?:thread\\/|search\\?)/.test(target) && target.length <= 25000) {
      const link = document.getElementById('open');
      link.href = target;
      link.hidden = false;
      document.getElementById('message').textContent = 'Continue in the AMC desktop app.';
    }
  } catch {}
</script>
</html>`)
  })
}
