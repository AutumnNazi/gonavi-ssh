import { useEffect, useRef, useState } from 'react'
import { Input, Modal, message } from 'antd'
import { invokeAs, describeError } from '../bridge'
import { decodeText, encodeText } from '../b64'
import { t } from '../i18n'

export interface PreviewTarget {
  connectionId: string
  path: string
  name: string
}

// 泛型是为了让调用方带上自己的附加字段（文件页要记 side，好在保存后刷新对应那一栏），
// 并且 onSaved 回调里把这些字段原样拿回来——不然调用方只能重新猜是哪个栏。
interface Props<T extends PreviewTarget> {
  /** 要预览的远端文件；null＝关闭弹窗。 */
  target: T | null
  onClose: () => void
  /** 保存成功后通知调用方刷新目录。 */
  onSaved?: (target: T) => void
}

// 与后端 sftp.preview 的 maxBytes 对齐：写大了后端也只给这么多，超出的部分
// 以 truncated 形式告知，弹窗里只读展示、不允许保存。
const PREVIEW_MAX_BYTES = 262144

// 远端小文件的内置预览编辑器：拉取 → 编辑 → 写回远端。
//
// 文件页与终端页的远端文件面板共用这一份：截断判定、二进制识别、以及"迟到响应
// 不许覆盖当前内容"的竞态处理，各写一遍迟早会有一边漏掉。
export function FilePreviewModal<T extends PreviewTarget>({ target, onClose, onSaved }: Props<T>) {
  const [draft, setDraft] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loadedTarget, setLoadedTarget] = useState<T | null>(null)
  const savingRequest = useRef<number | null>(null)
  const loaded = target !== null && loadedTarget === target
  // 打开别的文件、或保存后关窗时，在途的响应不能落到新内容上。
  const seq = useRef(0)
  // 调用方传的多半是内联箭头函数，每次渲染都是新引用。直接写进依赖会让弹窗每
  // 渲染一次就重新拉一遍远端文件，所以只读 ref，effect 只认 target。
  const close = useRef(onClose)
  const saved = useRef(onSaved)
  useEffect(() => { close.current = onClose; saved.current = onSaved }, [onClose, onSaved])

  useEffect(() => {
    const token = ++seq.current
    setLoadedTarget(null)
    setSaving(false)
    savingRequest.current = null
    setDraft('')
    setTruncated(false)
    if (!target) return
    void (async () => {
      try {
        const res = await invokeAs<{ dataBase64: string; truncated?: boolean }>('sftp.preview', {
          connectionId: target.connectionId,
          path: target.path,
          maxBytes: PREVIEW_MAX_BYTES,
        })
        if (token !== seq.current) return
        const text = decodeText(res.dataBase64)
        // 二进制内容铺进文本框只是一屏乱码，用户还可能顺手存回去把它写坏。
        const nul = [...text].filter(c => c === '\u0000').length
        if (nul > text.length / 100) {
          message.warning(`${target.name}: binary`)
          close.current()
          return
        }
        setDraft(text)
        setTruncated(!!res.truncated)
        setLoadedTarget(target)
      } catch (e) {
        if (token !== seq.current) return
        message.error(describeError(e))
        close.current()
      }
    })()
    return () => { seq.current++ }
  }, [target])

  const save = async () => {
    if (!target || !loaded || truncated || saving || savingRequest.current !== null) return
    const token = seq.current
    savingRequest.current = token
    setSaving(true)
    try {
      await invokeAs('sftp.writeFile', {
        connectionId: target.connectionId,
        path: target.path,
        dataBase64: encodeText(draft),
      })
      if (token !== seq.current) return
      setSaving(false)
      // 递增让在途的拉取作废：保存完就关窗，迟到的预览结果不该再翻开。
      seq.current++
      setLoadedTarget(null)
      message.success(t('sftp.saveFile'))
      saved.current?.(target)
      close.current()
    } catch (e) {
      if (token === seq.current) message.error(describeError(e))
    } finally {
      if (savingRequest.current === token) {
        savingRequest.current = null
        setSaving(false)
      }
    }
  }

  return (
    <Modal
      title={`${t('sftp.preview')}: ${target?.path ?? ''}`}
      open={target !== null}
      onCancel={() => close.current()}
      onOk={() => void save()}
      okText={t('sftp.saveFile')}
      okButtonProps={{ disabled: !loaded || truncated, loading: saving }}
      width={760}
      destroyOnHidden
    >
      {truncated && (
        <div style={{ color: '#faad14', fontSize: 12, marginBottom: 8 }}>{t('sftp.previewTruncated')}</div>
      )}
      <Input.TextArea
        rows={20}
        value={draft}
        onChange={e => setDraft(e.target.value)}
        style={{ fontFamily: 'Consolas, monospace' }}
        readOnly={!loaded || truncated || saving}
      />
    </Modal>
  )
}
