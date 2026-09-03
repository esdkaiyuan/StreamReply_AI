import type { LdaApi } from '../../preload/index'

declare global {
  interface Window { lda: LdaApi }
}
export {}
