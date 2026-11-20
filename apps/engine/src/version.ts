declare const AMC_VERSION: string | undefined

/** Set at build time; "dev" when running from source. */
export const VERSION: string = typeof AMC_VERSION === 'string' ? AMC_VERSION : 'dev'
