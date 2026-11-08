import { useEffect, useRef, type ComponentPropsWithRef } from 'react'

// 两个侧栏共用同一套指针、键盘和取消行为；拖动结束才提交宽度。
export function usePanelResize(width: number, min: number, reserve: number, reset: number, onChange?: (width: number) => void) {
  const ref = useRef<HTMLDivElement | null>(null)
  const drag = useRef<{ pointerId: number; x: number; width: number; preferredWidth: string } | null>(null)
  const limit = (handle: HTMLDivElement) => Math.max(min, (handle.parentElement?.parentElement?.clientWidth ?? 880) - reserve)
  useEffect(() => {
    const handle = ref.current
    if (!handle) return
    const update = () => {
      handle.setAttribute('aria-valuenow', String(Math.round(handle.parentElement!.getBoundingClientRect().width)))
      handle.setAttribute('aria-valuemax', String(limit(handle)))
    }
    const observer = new ResizeObserver(update)
    observer.observe(handle.parentElement!)
    observer.observe(handle.parentElement!.parentElement!)
    update()
    return () => observer.disconnect()
  }, [min, reserve])
  const resize = (handle: HTMLDivElement, next: number) => {
    const value = Math.round(Math.min(limit(handle), Math.max(min, next)))
    handle.parentElement!.style.width = `${value}px`
    handle.setAttribute('aria-valuenow', String(value))
    handle.setAttribute('aria-valuemax', String(limit(handle)))
    return value
  }
  const finish = (handle: HTMLDivElement, cancelled = false) => {
    const start = drag.current
    if (!start) return
    drag.current = null
    const pane = handle.parentElement!
    // CSS may clamp the pane in a small window; cancellation must restore its
    // preferred width so it can expand again when the window grows.
    if (cancelled) pane.style.width = start.preferredWidth
    const value = cancelled ? Math.round(pane.getBoundingClientRect().width) : resize(handle, pane.getBoundingClientRect().width)
    handle.setAttribute('aria-valuenow', String(value))
    handle.setAttribute('aria-valuemax', String(limit(handle)))
    handle.parentElement!.removeAttribute('data-resizing')
    if (handle.hasPointerCapture(start.pointerId)) handle.releasePointerCapture(start.pointerId)
    if (!cancelled) onChange?.(value)
  }
  const props: ComponentPropsWithRef<'div'> = {
    ref, role: 'separator', tabIndex: 0, 'aria-orientation': 'vertical',
    'aria-valuemin': min, 'aria-valuemax': ref.current ? limit(ref.current) : width, 'aria-valuenow': width,
    onPointerDown: event => {
      if (event.button !== 0 || !event.isPrimary || drag.current) return
      event.preventDefault()
      const handle = event.currentTarget
      handle.focus()
      drag.current = { pointerId: event.pointerId, x: event.clientX, width: handle.parentElement!.getBoundingClientRect().width, preferredWidth: handle.parentElement!.style.width }
      handle.parentElement!.setAttribute('data-resizing', 'true')
      handle.setPointerCapture(event.pointerId)
    },
    onPointerMove: event => {
      const start = drag.current
      if (start?.pointerId === event.pointerId) resize(event.currentTarget, start.width + event.clientX - start.x)
    },
    onPointerUp: event => { if (drag.current?.pointerId === event.pointerId) finish(event.currentTarget) },
    onPointerCancel: event => { if (drag.current?.pointerId === event.pointerId) finish(event.currentTarget, true) },
    onLostPointerCapture: event => finish(event.currentTarget, true),
    onDoubleClick: event => onChange?.(resize(event.currentTarget, reset)),
    onKeyDown: event => {
      if (event.key === 'Escape') { finish(event.currentTarget, true); return }
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
      event.preventDefault()
      const handle = event.currentTarget
      const current = handle.parentElement!.getBoundingClientRect().width
      const next = event.key === 'Home' ? min : event.key === 'End' ? limit(handle) : current + (event.key === 'ArrowRight' ? 16 : -16)
      onChange?.(resize(handle, next))
    },
  }
  return props
}
