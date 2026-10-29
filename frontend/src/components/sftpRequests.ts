export type PaneIdentity = readonly [kind: 'local' | 'remote', profileId: string, connectionId: string, path: string]
export interface PaneScope { epoch: number }

// 每栏独立的目录世代；同路径刷新也废弃旧选择、用量与分页。
export function createPaneRequests() {
  let identity: PaneIdentity | undefined
  let epoch = 0, loaded = false, offset = 0
  let pending: { scope: PaneScope; offset: number } | undefined
  const current = (scope: PaneScope) => scope.epoch === epoch
  const matches = (next: PaneIdentity) => !!identity && next.every((value, i) => value === identity![i])
  const invalidate = () => { epoch++; loaded = false; offset = 0; pending = undefined }
  return {
    bind(next: PaneIdentity) {
      if (!matches(next)) { invalidate(); identity = next }
    },
    matches,
    invalidate,
    capture: (): PaneScope => ({ epoch }),
    current,
    source: (scope: PaneScope) => loaded && current(scope),
    begin(page: number) {
      if (page === 0) invalidate()
      else if (!loaded || pending || page !== offset + 500) return
      const request = { scope: { epoch }, offset: page }
      pending = request
      return request
    },
    accepts(request: { scope: PaneScope; offset: number }) { return current(request.scope) && pending === request },
    finish(request: { scope: PaneScope; offset: number }, resolvedIdentity?: PaneIdentity) {
      if (!current(request.scope) || pending !== request) return false
      pending = undefined; loaded = true; offset = request.offset
      if (resolvedIdentity) identity = resolvedIdentity
      return true
    },
    fail(request: { scope: PaneScope; offset: number }) {
      if (!current(request.scope) || pending !== request) return false
      pending = undefined
      return true
    },
  }
}
