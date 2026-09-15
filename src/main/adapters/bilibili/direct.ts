import { httpJson } from '../../net/http'
import {
  createDirectClient,
  type DirectClient,
  type DirectHooks,
  type HttpJson,
  type SocketLike
} from './directClient'

/**
 * electron 侧接线：把网络与 socket 注入给平台无关的直连引擎。
 * HTTP 复用统一网络层（含双栈兜底，见 net/http.ts）。
 */

const directHttp: HttpJson = (url, referer) => httpJson(url, referer)

export function createBilibiliDirect(roomId: string, hooks: DirectHooks): DirectClient {
  return createDirectClient(roomId, hooks, {
    http: directHttp,
    createSocket: (url) => new WebSocket(url) as unknown as SocketLike
  })
}

export type { DirectClient, DirectHooks }
