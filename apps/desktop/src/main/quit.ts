import type { Event } from 'electron'

export const QUIT_DRAIN_MS = 4_000

export function createQuitHandler(drain: () => Promise<unknown>, exit: () => void) {
  let draining = false

  return (event: Pick<Event, 'preventDefault'>) => {
    event.preventDefault()
    if (draining) return
    draining = true

    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, QUIT_DRAIN_MS)
    })
    const work = Promise.resolve().then(drain)
    const finish = () => {
      clearTimeout(timer)
      exit()
    }
    void Promise.race([work, deadline]).then(finish, finish)
  }
}
