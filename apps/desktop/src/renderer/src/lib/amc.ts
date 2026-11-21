import type { AmcApi } from '../../../shared/api'

let fixture: AmcApi | undefined

export async function loadFixture(scenario: string) {
  if (import.meta.env.DEV) {
    const { createFixture } = await import('../dev/mail-fixture')
    fixture = createFixture(scenario)
  }
}

export function getAmc(): AmcApi {
  return fixture ?? window.amc
}
