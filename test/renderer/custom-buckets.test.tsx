import { act, fireEvent, screen, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { rendererAdapter } from './adapter'
import { listbox, mount, reader, selected } from './workspace'

it('creates and renames a Bucket in Settings, preserving the assigned Thread and its view', async () => {
  const adapter = await mount(rendererAdapter('custom-buckets'))
  const mail = selected()
  const message = reader()
  const list = listbox()
  const openSettings = () => act(async () => adapter.emitOpenSettings())
  const settings = () => within(screen.getByRole('dialog', { name: 'Settings' }))
  const closeSettings = () =>
    act(async () => fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' }))
  const click = (element: HTMLElement) => act(async () => fireEvent.click(element))

  await openSettings()
  await click(settings().getByRole('button', { name: 'New Bucket' }))
  const input = settings().getByRole('textbox', { name: 'Bucket name' })
  expect(document.activeElement).toBe(input)
  fireEvent.change(input, { target: { value: 'Receipts' } })
  await click(settings().getByRole('button', { name: 'Create Bucket' }))
  expect(settings().getByRole('button', { name: 'Edit Receipts' })).toBeTruthy()
  await closeSettings()

  const catalog = await adapter.api.bucketCatalog?.()
  const receipt = catalog?.definitions.find(({ name }) => name === 'Receipts')
  if (!receipt) throw new Error('Custom Bucket was not created')
  await act(async () => {
    await adapter.api.setBucketById({
      threadId: 'thread-1',
      bucketId: receipt.id,
      reason: 'Synthetic receipt',
    })
  })
  expect(listbox()).toBe(list)
  expect(selected()).toBe(mail)
  expect(reader()).toBe(message)

  await click(screen.getByRole('button', { name: 'Triage', expanded: false }))
  await click(screen.getByRole('button', { name: 'Receipts' }))
  const bucketList = listbox()
  const bucketRow = selected()

  await openSettings()
  await click(settings().getByRole('button', { name: 'Edit Receipts' }))
  fireEvent.change(settings().getByRole('textbox', { name: 'Bucket name' }), {
    target: { value: 'Purchases' },
  })
  await click(settings().getByRole('button', { name: 'Save Bucket' }))
  await closeSettings()
  expect(screen.getByRole('heading', { name: 'Purchases' })).toBeTruthy()
  expect(listbox()).toBe(bucketList)
  expect(selected()).toBe(bucketRow)

  await openSettings()
  await click(settings().getByRole('button', { name: 'Archive Purchases' }))
  await click(settings().getByText('Archived Buckets'))
  await click(settings().getByRole('button', { name: 'Purchases' }))
  expect(screen.getByRole('heading', { name: 'Purchases' })).toBeTruthy()
  expect(selected().getAttribute('data-thread-id')).toBe('thread-1')
  expect(screen.queryByRole('button', { name: 'Purchases', current: 'page' })).toBeNull()
})

it('preserves concurrent edits to Bucket fields the owner did not change', async () => {
  const adapter = rendererAdapter('custom-buckets')
  const manage = adapter.api.manageBuckets
  if (!manage) throw new Error('Expected custom Bucket fixture')
  const initial = await manage({
    kind: 'create',
    input: {
      name: 'Receipts',
      description: 'All purchase receipts',
      automatic: true,
      requestId: crypto.randomUUID(),
    },
  })
  const original = initial.definitions.find(({ builtIn }) => !builtIn)
  if (!original?.id.startsWith('bucket.custom.')) throw new Error('Expected custom definition')
  const id = original.id as `bucket.custom.${string}`
  await mount(adapter)
  await act(async () => adapter.emitOpenSettings())
  const settings = within(screen.getByRole('dialog', { name: 'Settings' }))
  const click = (element: HTMLElement) => act(async () => fireEvent.click(element))
  await click(settings.getByRole('button', { name: 'Edit Receipts' }))
  fireEvent.change(settings.getByRole('textbox', { name: 'Bucket name' }), {
    target: { value: 'Purchases' },
  })
  await act(async () => {
    await manage({
      kind: 'update',
      id,
      input: {
        description: 'Only completed orders',
        automatic: false,
        expectedRevision: initial.revision,
      },
    })
  })
  expect(settings.getByRole('button', { name: 'Save Bucket' })).toHaveProperty('disabled', true)
  expect(
    settings.getByRole('textbox', { name: 'When should triage use this Bucket?' }),
  ).toHaveProperty('value', 'Only completed orders')
  await click(settings.getByRole('button', { name: 'Continue editing' }))
  await click(settings.getByRole('button', { name: 'Save Bucket' }))
  expect(
    (await adapter.api.bucketCatalog?.())?.definitions.find((item) => item.id === id),
  ).toMatchObject({
    name: 'Purchases',
    description: 'Only completed orders',
    automatic: false,
  })
})
