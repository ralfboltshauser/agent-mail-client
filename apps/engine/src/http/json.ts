import type { HonoRequest } from 'hono'

export async function readJson(request: HonoRequest): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    // The caller returns its validation response and request logging records the status.
    return null
  }
}
