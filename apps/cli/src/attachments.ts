import { createWriteStream } from 'node:fs'
import { link, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { response } from './client.ts'
import type { CliConfig } from './config.ts'

export async function downloadAttachment(config: CliConfig, id: string, output: string) {
  const destination = resolve(output)
  const directory = await mkdtemp(join(dirname(destination), '.amc-download-'))
  const temporaryFile = join(directory, 'attachment')
  try {
    const result = await response(config.engineUrl, `/v1/attachments/${encodeURIComponent(id)}`, {
      token: config.token,
      redirect: 'error',
    })
    if (!result.body) throw new Error('The Engine returned no attachment data.')
    await pipeline(result.body, createWriteStream(temporaryFile, { mode: 0o600 }))
    try {
      // Publish the complete file in one step, even if another download beat us to this path.
      await link(temporaryFile, destination)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw new Error('The output file already exists. Choose a new path.', { cause: error })
      throw error
    }
  } finally {
    await rm(directory, { recursive: true })
  }
}
