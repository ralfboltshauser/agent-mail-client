const imagePath = '/__amc_fixture_image'

const results = (job: string) => `
  <table style="width:100%;border-collapse:collapse;max-width:544px;margin:auto"><tr><td style="padding:16px">
  <table style="width:100%;border-collapse:collapse"><thead><tr>
    <th id="probe-status" style="width:24px;box-sizing:border-box;padding:16px 0 16px 16px;text-align:left">Status</th>
    <th style="width:100%;padding:16px">Job</th>
    <th style="white-space:nowrap;padding-right:16px">Annotations</th>
  </tr></thead><tbody><tr><td style="padding-left:16px">•</td>
    <td id="probe-job" style="padding:16px">${job}</td><td>10</td></tr></tbody></table></td></tr></table>
`

const wide = (dir: 'ltr' | 'rtl') => `
  <!doctype html><html dir="${dir}" style="overflow:hidden!important">
    <body style="overflow:hidden!important">
      <table style="width:780px;min-width:780px"><tr><th colspan="2">Statement</th></tr><tr>
        <td>First column</td><td style="text-align:end"><a id="probe-end" href="https://example.test/invoice">Final column</a></td>
      </tr></table>
      <pre id="probe-code">${'0123456789'.repeat(6)}</pre>
      <p id="probe-last">Last line</p>
    </body>
  </html>`

export function htmlReaderFixture(id: string): string | null {
  switch (id) {
    case 'thread-1:latest':
      return `<!doctype html><html lang="en"><head><style>
        body > .probe-first:first-child { color:rgb(12,34,56); }
        .probe-column { display:inline-block; }
        @media (max-width:420px) { .probe-column { display:block; } }
      </style></head><body>
        <div id="probe-first" class="probe-first">First line</div>
        ${results('Example job<br>Finished in 2 minutes')}
        <div><span id="probe-responsive" class="probe-column">First</span><span class="probe-column">Second</span></div>
        <img id="probe-cid" src="cid:fixture-image" width="120" height="120">
        <img id="probe-oversized" src="cid:fixture-image" width="720" height="360">
      </body></html>`
    case 'thread-1:older':
      return '<p id="probe-older">Earlier message</p>'
    case 'thread-2:latest':
      return `${results('W'.repeat(180))}<p id="probe-prose">${'W'.repeat(180)}</p>`
    case 'thread-3:latest':
      return wide('ltr')
    case 'thread-4:latest':
      return wide('rtl')
    case 'thread-5:latest':
      return `<style>
        .probe-feedback { height:300px; }
        @media (min-height:200px) { .probe-feedback { height:120px; } }
      </style><div id="probe-feedback" class="probe-feedback">Resize fixture</div>`
    case 'thread-6:latest':
      return `<p id="probe-images">Remote images</p>
        <img id="probe-remote" width="120" src="${location.origin}${imagePath}?source=message">
        <img id="probe-missing" src="${location.origin}${imagePath}?source=missing">`
    default:
      return null
  }
}

export const readerImageAttachment = {
  id: 'reader-image',
  filename: 'fixture.png',
  mimeType: 'image/png',
  size: 128,
  inline: true,
  contentId: 'fixture-image',
}

// A 2 × 1 PNG so the authored square dimensions differ from the intrinsic ratio.
export const readerImage =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAQAAABeK7cBAAAADklEQVR42mP8z8DwHwAFAAH/ScLttAAAAABJRU5ErkJggg=='
