import { useEffect, useState } from 'react'
import { App as AntApp, Button, Card, Form, Input, List, Popconfirm, Space, Switch } from 'antd'
import { invokeAs, describeError } from '../bridge'
import { t } from '../i18n'
import type { PluginSettings, QuickCommand } from '../types'

interface KnownHost {
  addr: string
  fingerprint: string
  keyType: string
}

interface Props {
  settings: PluginSettings | null
  onSaved: () => void
}

// 设置面板：只读开关、sudo 白名单、只读 exec 白名单、快速命令、
// known_hosts 管理。
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

  useEffect(() => {
    if (settings) {
      form.setFieldsValue({
        readOnly: settings.readOnly,
        sudoAllowlist: (settings.sudoAllowlist ?? []).join('\n'),
        readOnlyExec: (settings.readOnlyExecAllowlist ?? []).join('\n'),
        dangerous: (settings.dangerousPatterns ?? []).join('\n'),
        localPaths: (settings.localPathAllowlist ?? []).join('\n'),
        quickCommands: settings.quickCommands ?? [],
        cwdFollow: !!settings.cwdFollow,
      })
    }
  }, [settings, form])

  const save = async () => {
    const v = await form.validateFields()
    const toList = (s: string | undefined) =>
      (s ?? '').split('\n').map(x => x.trim()).filter(Boolean)
    const next: PluginSettings = {
      readOnly: !!v.readOnly,
      sudoAllowlist: toList(v.sudoAllowlist),
      readOnlyExecAllowlist: toList(v.readOnlyExec),
      dangerousPatterns: toList(v.dangerous),
      localPathAllowlist: toList(v.localPaths),
      quickCommands: (v.quickCommands ?? []).filter((q: QuickCommand) => q.name && q.command),
      historyLimit: settings?.historyLimit ?? 500,
      historyEnabled: settings?.historyEnabled,
      cwdFollow: !!v.cwdFollow,
    }
    try {
      await invokeAs('settings.set', { settings: next })
      onSaved()
    } catch (e) {
      message.error(describeError(e))
    }
  }

  return (
    <div className="settings-wrap">
      <Card title={t('tab.settings')} style={{ maxWidth: 760, marginBottom: 16 }}>
        <Form form={form} layout="vertical">
          <Form.Item name="readOnly" valuePropName="checked" label={t('settings.readOnly')}>
            <Switch />
          </Form.Item>
          <Form.Item name="readOnlyExec" label={t('settings.readOnlyExec')}>
            <Input.TextArea rows={3} style={{ fontFamily: 'Consolas, monospace' }} />
          </Form.Item>
          <Form.Item name="cwdFollow" valuePropName="checked" label={t('settings.cwdFollow')}>
            <Switch />
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
          <Button type="primary" onClick={save}>{t('settings.save')}</Button>
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
