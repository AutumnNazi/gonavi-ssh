import { useCallback, useEffect, useRef, useState } from 'react'
import { App as AntApp, Button, Card, Form, Input, List, Popconfirm, Space, Switch } from 'antd'
import { invokeAs, describeError } from '../bridge'
import { t } from '../i18n'
import type { PluginSettings, QuickCommand, TreeCommand } from '../types'

interface KnownHost {
  addr: string
  fingerprint: string
  keyType: string
}

interface Props {
  settings: PluginSettings | null
  /** 每次改动落盘后回调：上层重新拉一次设置，让别处（终端页、文件面板）看到新值。 */
  onSaved: () => void
}

// 文本域停手多久算"写完了"。太短会让半截输入频繁落盘，太长又像没生效。
const SAVE_DEBOUNCE_MS = 400

/** 多行文本域 → 去空行、去首尾空格的列表。 */
const toList = (value: unknown): string[] =>
  (typeof value === 'string' ? value : '').split('\n').map(line => line.trim()).filter(Boolean)

// 设置面板：只读开关、sudo 白名单、只读 exec 白名单、本地回显、显示远端文件面板、
// 命令跳转映射、快速命令、known_hosts 管理。
// 目录跟随不在这里——它的开关长在远端文件面板底部，一处开关一处状态。
//
// 面板里没有保存按钮：每一项改完就落盘。文本域走防抖，停手一会儿再写，
// 免得每敲一个字符过一遍桥、也免得半截输入被当成最终值。
export function SettingsPanel({ settings, onSaved }: Props) {
  const [form] = Form.useForm()
  const { message } = AntApp.useApp()
  const [hosts, setHosts] = useState<KnownHost[]>([])

  const loadHosts = () => {
    invokeAs<{ hosts: KnownHost[] }>('knownHosts.list', {})
      .then(res => setHosts(res.hosts ?? []))
      .catch(() => {})
  }

  useEffect(() => {
    loadHosts()
  }, [])

  // 设置只灌进表单一次。之后再灌会把用户正在编辑的内容冲掉——文件面板底部的
  // 跟随勾选、面板上的收起按钮都会在后台改设置，表单不该被它们带着重置。
  const seeded = useRef(false)
  useEffect(() => {
    if (!settings || seeded.current) return
    form.setFieldsValue({
      readOnly: settings.readOnly,
      sudoAllowlist: (settings.sudoAllowlist ?? []).join('\n'),
      readOnlyExec: (settings.readOnlyExecAllowlist ?? []).join('\n'),
      dangerous: (settings.dangerousPatterns ?? []).join('\n'),
      localPaths: (settings.localPathAllowlist ?? []).join('\n'),
      quickCommands: settings.quickCommands ?? [],
      treeCommands: settings.treeCommands ?? [],
      localEcho: settings.localEcho === true,
      showFileTree: settings.showFileTree === true,
    })
    seeded.current = true
  }, [settings, form])

  // 表单是唯一真相源。缓存一份最新值而不是每次去问 form：关窗时要把最后一次编辑
  // 补写出去，那一刻 form 实例还读不读得出值，不该由这里赌。
  const latest = useRef<Record<string, unknown>>({})
  const pending = useRef<number | null>(null)
  const persistRef = useRef<() => void>(() => {})

  const persist = useCallback(async () => {
    const v = latest.current
    const next: PluginSettings = {
      readOnly: !!v.readOnly,
      sudoAllowlist: toList(v.sudoAllowlist),
      readOnlyExecAllowlist: toList(v.readOnlyExec),
      dangerousPatterns: toList(v.dangerous),
      localPathAllowlist: toList(v.localPaths),
      quickCommands: ((v.quickCommands ?? []) as QuickCommand[]).filter(q => q.name && q.command),
      historyLimit: settings?.historyLimit ?? 500,
      historyEnabled: settings?.historyEnabled,
      // 目录跟随的开关长在文件面板底部（WindTerm 也把同步按钮放在文件面板里）：
      // 原样带回当前值，别在全量写入时把它抹掉。
      cwdFollow: settings?.cwdFollow,
      localEcho: !!v.localEcho,
      showFileTree: !!v.showFileTree,
      treeCommands: ((v.treeCommands ?? []) as TreeCommand[]).filter(jump => jump.name && jump.path),
    }
    try {
      await invokeAs('settings.set', { settings: next })
      onSaved()
    } catch (e) {
      message.error(describeError(e))
    }
  }, [settings, onSaved, message])
  persistRef.current = persist

  // 防抖：连着敲字时只在停手后写一次。
  const scheduleSave = useCallback(() => {
    if (pending.current !== null) clearTimeout(pending.current)
    pending.current = setTimeout(() => {
      pending.current = null
      void persistRef.current()
    }, SAVE_DEBOUNCE_MS)
  }, [])

  // 卸载（关窗）前把还没落盘的补上，别让最后一次编辑无声无息地丢。
  useEffect(() => () => {
    if (pending.current === null) return
    clearTimeout(pending.current)
    pending.current = null
    void persistRef.current()
  }, [])

  return (
    <div className="settings-wrap">
      <Card title={t('tab.settings')} style={{ maxWidth: 760, marginBottom: 16 }}>
        <Form
          form={form}
          layout="vertical"
          // 任何一项变动都排一次落盘。值缓存下来给 persist 用，见上。
          onValuesChange={(_, all) => { latest.current = all; scheduleSave() }}
        >
          <Form.Item name="readOnly" valuePropName="checked" label={t('settings.readOnly')}>
            <Switch />
          </Form.Item>
          <Form.Item name="readOnlyExec" label={t('settings.readOnlyExec')}>
            <Input.TextArea rows={3} style={{ fontFamily: 'Consolas, monospace' }} />
          </Form.Item>
          <Form.Item name="localEcho" valuePropName="checked" label={t('settings.localEcho')}>
            <Switch />
          </Form.Item>
          <Form.Item name="showFileTree" valuePropName="checked" label={t('settings.showFileTree')}>
            <Switch />
          </Form.Item>
          <Form.Item label={t('settings.treeCommands')} extra={t('settings.treeHint')}>
            <Form.List name="treeCommands">
              {(fields, { add, remove }) => (
                <>
                  {fields.map(field => (
                    <Space key={field.key} style={{ display: 'flex', marginBottom: 4 }} align="baseline">
                      <Form.Item name={[field.name, 'name']} noStyle>
                        <Input placeholder={t('settings.treeName')} style={{ width: 200 }} />
                      </Form.Item>
                      <Form.Item name={[field.name, 'path']} noStyle>
                        <Input placeholder={t('settings.treePath')} style={{ width: 360 }} />
                      </Form.Item>
                      <Popconfirm title="?" onConfirm={() => remove(field.name)}>
                        <a>✕</a>
                      </Popconfirm>
                    </Space>
                  ))}
                  <Button size="small" onClick={() => add({ name: '', path: '' })}>
                    + {t('settings.treeCommands')}
                  </Button>
                </>
              )}
            </Form.List>
          </Form.Item>
          <Form.Item name="dangerous" label={t('settings.dangerous')}>
            <Input.TextArea rows={3} style={{ fontFamily: 'Consolas, monospace' }} placeholder="rm -rf ; mkfs ; dd if= ; shutdown" />
          </Form.Item>
          <Form.Item name="localPaths" label={t('settings.paths')}>
            <Input.TextArea rows={2} style={{ fontFamily: 'Consolas, monospace' }} />
          </Form.Item>
          <Form.Item name="sudoAllowlist" label={t('settings.sudo')}>
            <Input.TextArea rows={6} style={{ fontFamily: 'Consolas, monospace' }} />
          </Form.Item>
          <Form.Item label={t('settings.quick')}>
            <Form.List name="quickCommands">
              {(fields, { add, remove }) => (
                <>
                  {fields.map(field => (
                    <Space key={field.key} style={{ display: 'flex', marginBottom: 4 }} align="baseline">
                      <Form.Item name={[field.name, 'name']} noStyle>
                        <Input placeholder={t('settings.quickName')} style={{ width: 140 }} />
                      </Form.Item>
                      <Form.Item name={[field.name, 'command']} noStyle>
                        <Input placeholder={t('settings.quickCommand')} style={{ width: 420 }} />
                      </Form.Item>
                      <Popconfirm title="?" onConfirm={() => remove(field.name)}>
                        <a>✕</a>
                      </Popconfirm>
                    </Space>
                  ))}
                  <Button size="small" onClick={() => add({ name: '', command: '' })}>
                    + {t('settings.quick')}
                  </Button>
                </>
              )}
            </Form.List>
          </Form.Item>
        </Form>
      </Card>
      <Card title={t('settings.knownHosts')} style={{ maxWidth: 760 }} extra={
        <Button size="small" onClick={loadHosts}>{t('sftp.refresh')}</Button>
      }>
        <List
          size="small"
          dataSource={hosts}
          locale={{ emptyText: t('sftp.transferIdle') }}
          renderItem={h => (
            <List.Item
              actions={[
                <Popconfirm
                  key="del"
                  title={`${t('conn.delete')} ${h.addr}?`}
                  onConfirm={async () => {
                    try {
                      await invokeAs('knownHosts.remove', { addr: h.addr })
                      loadHosts()
                    } catch (e) {
                      message.error(describeError(e))
                    }
                  }}
                >
                  <a>{t('conn.delete')}</a>
                </Popconfirm>,
              ]}
            >
              <List.Item.Meta
                title={<span style={{ fontFamily: 'Consolas, monospace', fontSize: 13 }}>{h.addr}</span>}
                description={`${h.keyType} · ${h.fingerprint}`}
              />
            </List.Item>
          )}
        />
      </Card>
    </div>
  )
}
