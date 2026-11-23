import { createRequire } from 'node:module'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const desktop = fileURLToPath(new URL('../../apps/desktop/', import.meta.url))
const renderer = join(desktop, 'src/renderer')
const desktopRequire = createRequire(join(desktop, 'package.json'))
const load = (id) => import(pathToFileURL(desktopRequire.resolve(id)).href)

export const requests = { message: 0, parent: 0, missing: 0 }
const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jPioAAAAASUVORK5CYII=',
  'base64',
)

export async function startReaderServer() {
  const [{ createServer }, { default: react }, { default: tailwind }] = await Promise.all([
    load('vite'),
    load('@vitejs/plugin-react'),
    load('@tailwindcss/vite'),
  ])
  const server = await createServer({
    root: renderer,
    configFile: false,
    resolve: { alias: { '@': join(renderer, 'src') } },
    server: { host: '127.0.0.1', port: 0, hmr: false, watch: null },
    plugins: [
      react(),
      tailwind(),
      {
        name: 'synthetic-message-image',
        configureServer({ middlewares }) {
          middlewares.use('/__amc_fixture_image', async (req, res) => {
            const source = new URL(req.url, 'http://localhost').searchParams.get('source')
            if (!Object.hasOwn(requests, source)) {
              res.writeHead(400).end()
              return
            }
            requests[source]++
            if (source === 'missing') {
              res.writeHead(404).end()
              return
            }
            await delay(200)
            res
              .writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' })
              .end(pixel)
          })
        },
      },
    ],
  })
  await server.listen()
  return server
}
