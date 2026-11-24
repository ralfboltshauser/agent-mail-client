import { randomUUID } from 'node:crypto'
import { BucketCatalog, BucketId, CreateBucket, ReorderBuckets, UpdateBucket } from '@amc/protocol'
import type { Command } from 'commander'
import { z } from 'zod'
import { authed, EngineError } from './client.ts'
import type { CliConfig } from './config.ts'
import { mailTool } from './mcp.ts'

export async function ownerBucketCatalog(config: CliConfig) {
  try {
    return BucketCatalog.parse(await authed(config)('/v1/buckets'))
  } catch (error) {
    if (error instanceof EngineError && error.status === 404)
      throw new Error('Upgrade the Engine to manage custom Buckets.', { cause: error })
    throw error
  }
}

export function agentBucketCatalog(config: CliConfig) {
  return mailTool(
    config,
    true,
    'list_buckets',
    {},
    {
      result: z.object({
        revision: z.number().int(),
        definitions: z.array(z.object({ id: BucketId, name: z.string() })),
      }),
    },
  )
}

export function registerBucketCommands(
  program: Command,
  config: () => CliConfig,
  agentMode: () => boolean,
) {
  const buckets = program.command('buckets').description('Manage custom triage Buckets')
  const output = (value: unknown, message: string, json?: boolean) =>
    console.log(json ? JSON.stringify(value, null, 2) : message)

  buckets
    .command('list')
    .option('--archived', 'include archived Buckets')
    .option('--json')
    .action(async ({ archived, json }) => {
      if (agentMode()) {
        if (archived) throw new Error('Archived Buckets require a paired owner.')
        const catalog = await agentBucketCatalog(config())
        return output(
          catalog,
          catalog.definitions.map(({ id, name }) => `${id}\t${name}`).join('\n'),
          json,
        )
      }
      const catalog = await ownerBucketCatalog(config())
      const definitions = catalog.definitions.filter((item) => archived || !item.archived)
      output(
        { ...catalog, definitions },
        definitions
          .map((item) => `${item.id}\t${item.name}${item.archived ? ' (archived)' : ''}`)
          .join('\n'),
        json,
      )
    })
  buckets
    .command('show <id>')
    .option('--json')
    .action(async (id, { json }) => {
      const { definitions } = await ownerBucketCatalog(config())
      const item = definitions.find((candidate) => candidate.id === id)
      if (!item) throw new Error('Bucket not found.')
      output(
        item,
        [
          `${item.name} (${item.id})`,
          item.description,
          item.archived
            ? 'Archived'
            : item.automatic
              ? 'Automatic assignment enabled'
              : 'Manual assignment',
        ]
          .filter(Boolean)
          .join('\n'),
        json,
      )
    })
  buckets
    .command('create <name>')
    .option('--description <text>')
    .option('--auto')
    .option('--request-id <uuid>', 'reuse the same create request on retry')
    .option('--json')
    .action(async (name, { description, auto, requestId, json }) => {
      const body = CreateBucket.parse({
        name,
        description,
        automatic: auto,
        requestId: requestId ?? randomUUID(),
      })
      const result = await authed(config())<{ definition: { id: string; name: string } }>(
        '/v1/buckets',
        { method: 'POST', body },
      )
      output(result, `Created ${result.definition.name} (${result.definition.id})`, json)
    })
  type Edit = { name?: string; description?: string; automatic?: boolean; archived?: boolean }
  const update = async (id: string, patch: Edit, json?: boolean) => {
    const connection = config()
    const { revision } = await ownerBucketCatalog(connection)
    const result = await authed(connection)(`/v1/buckets/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: UpdateBucket.parse({ ...patch, expectedRevision: revision }),
    })
    output(result, 'Bucket updated.', json)
  }
  buckets
    .command('edit <id>')
    .option('--name <name>')
    .option('--description <text>')
    .option('--auto')
    .option('--no-auto')
    .option('--json')
    .action((id, { name, description, auto, json }) =>
      update(id, { name, description, automatic: auto }, json),
    )
  buckets
    .command('archive <id>')
    .option('--json')
    .action((id, { json }) => update(id, { archived: true }, json))
  buckets
    .command('restore <id>')
    .option('--json')
    .action((id, { json }) => update(id, { archived: false }, json))
  buckets
    .command('reorder <ids...>')
    .option('--json')
    .action(async (ids, { json }) => {
      const connection = config()
      const { revision } = await ownerBucketCatalog(connection)
      const body = ReorderBuckets.parse({ ids, expectedRevision: revision })
      const result = await authed(connection)('/v1/buckets/order', { method: 'PUT', body })
      output(result, 'Bucket order saved.', json)
    })
}
