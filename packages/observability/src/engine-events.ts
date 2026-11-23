const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'OTHER'] as const
export type HttpMethod = (typeof methods)[number]
export const httpMethod = (method: string): HttpMethod =>
  methods.find((entry) => entry === method) ?? 'OTHER'

export const engineEvents = {
  'http.request': {
    fields: {
      method: methods,
      route: 'route',
      status: 'status',
      durationMs: 'duration',
      err: 'error',
    },
  },
} as const
