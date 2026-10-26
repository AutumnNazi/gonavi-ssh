import { useMemo, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Tag,
  Typography,
  message,
} from 'antd'
import { PlusOutlined, DownloadOutlined, ReloadOutlined } from '@ant-design/icons'
import { invokeAs, describeError } from '../bridge'
import { t } from '../i18n'
import type { AuthMethod, ConnectionInfo, ProfileView } from '../types'

export type { ProfileView, ConnectionInfo } from '../types'

interface JumpFormValues {
  host: string
  port?: number
  user: string
  authMethod: AuthMethod
  keyPath?: string
  password?: string
  passphrase?: string
}

interface ProfileFormValues {
  id?: string
  name: string
  host: string
  port?: number
  user: string
  authMethod: AuthMethod
  keyPath?: string
  password?: string
  passphrase?: string
  sudoPassword?: string
  jumps?: JumpFormValues[]
}

interface Props {
  profiles: ProfileView[]
  connections: ConnectionInfo[]
  onChanged: () => void
  onConnect: (p: ProfileView) => void
  onConnectionsChanged: () => void
}

const authOptions = [
  { value: 'password', label: t('auth.password') },
  { value: 'key', label: t('auth.key') },
  { value: 'agent', label: t('auth.agent') },
  { value: 'none', label: t('auth.none') },
]

export function ProfilePanel({
  profiles,
  connections,
  onChanged,
  onConnect,
  onConnectionsChanged,
}: Props) {
  const [editing, setEditing] = useState<ProfileView | 'new' | null>(null)
  // 测试连接结果展示在表单内（成功显示服务器版本与指纹，失败显示原因）。
  const [testResult, setTestResult] = useState<{
    ok: boolean
    serverVersion?: string
    fingerprint?: string
    error?: string
  } | null>(null)
  const [form] = Form.useForm<ProfileFormValues>()
  const authMethod = Form.useWatch('authMethod', form)

  const connByProfile = useMemo(() => {
    const map = new Map<string, ConnectionInfo>()
    for (const c of connections) {
      map.set(c.profileId, c)
    }
    return map
  }, [connections])

  const openForm = (p: ProfileView | 'new') => {
    setTestResult(null)
    setEditing(p)
    if (p === 'new') {
      form.resetFields()
    } else {
      form.setFieldsValue({
        id: p.id,
        name: p.name,
        host: p.host,
        port: p.port,
        user: p.user,
        authMethod: p.authMethod,
        keyPath: p.keyPath,
        password: '',
        passphrase: '',
        sudoPassword: '',
        jumps: (p.jumps ?? []).map(j => ({
          host: j.host, port: j.port, user: j.user,
          authMethod: j.authMethod, keyPath: j.keyPath,
          password: '', passphrase: '',
        })),
      })
    }
  }

  const saveProfile = async () => {
    const values = await form.validateFields()
    try {
      await invokeAs('profile.save', { profile: values })
      message.success(values.id ? t('form.save') : t('form.save'))
      setEditing(null)
      onChanged()
    } catch (e) {
      message.error(describeError(e))
    }
  }

  const testProfile = async () => {
    const values = await form.validateFields()
    setTestResult(null)
    try {
      const res = await invokeAs<{
        ok: boolean
        serverVersion?: string
        fingerprint?: string
        error?: string
      }>('profile.test', { profile: values })
      setTestResult(res)
    } catch (e) {
      setTestResult({ ok: false, error: describeError(e) })
    }
  }

  const deleteProfile = async (p: ProfileView) => {
    try {
      await invokeAs('profile.delete', { id: p.id })
      onChanged()
      onConnectionsChanged()
    } catch (e) {
      message.error(describeError(e))
    }
  }

  const disconnect = async (c: ConnectionInfo) => {
    try {
      await invokeAs('conn.close', { connectionId: c.connectionId })
      onConnectionsChanged()
    } catch (e) {
      message.error(describeError(e))
    }
  }

  const importFromGonavi = async () => {
    try {
      const res = await invokeAs<{ imported: number; skipped: number; root: string }>(
        'profile.importFromGonavi', {},
      )
      if (res.imported > 0) {
        message.success(`imported ${res.imported}, skipped ${res.skipped}`)
        onChanged()
      } else {
        message.info(`no SSH-tunnel connections found (root: ${res.root})`)
      }
    } catch (e) {
      message.error(describeError(e))
    }
  }

  // 连接状态徽标。
  const stateBadge = (conn?: ConnectionInfo) => {
    if (!conn) return null
    switch (conn.state) {
      case 'ready':
        return <Badge status="success" text={t('conn.connected')} />
      case 'connecting':
        return <Badge status="processing" text={t('conn.connecting')} />
      case 'needInput':
        return <Badge status="warning" text={t('conn.needInput')} />
      case 'failed':
        return <Badge status="error" text={conn.error?.slice(0, 40) ?? 'failed'} />
      default:
        return null
    }
  }

  const jumpItem = (idx: number) => (
    <>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {`#${idx + 1}`}
      </Typography.Text>
      <Space style={{ display: 'flex' }} align="start">
        <Form.Item name={[idx, 'host']} rules={[{ required: true }]} style={{ flex: 1, minWidth: 160 }}>
          <Input placeholder="host" />
        </Form.Item>
        <Form.Item name={[idx, 'port']} initialValue={22}>
          <InputNumber min={1} max={65535} style={{ width: 84 }} placeholder="22" />
        </Form.Item>
        <Form.Item name={[idx, 'user']} rules={[{ required: true }]} style={{ width: 120 }}>
          <Input placeholder="user" />
        </Form.Item>
      </Space>
      <Form.Item name={[idx, 'authMethod']} initialValue="password">
        <Select size="small" options={authOptions} style={{ width: 140 }} />
      </Form.Item>
      <Form.Item noStyle shouldUpdate>
        {({ getFieldValue }) => {
          const jm = getFieldValue(['jumps', idx, 'authMethod'])
          return (
            <>
              {jm === 'key' && (
                <Form.Item name={[idx, 'keyPath']} rules={[{ required: true }]}>
                  <Input placeholder="private key path" />
                </Form.Item>
              )}
              {jm === 'password' && (
                <Form.Item name={[idx, 'password']}>
                  <Input.Password placeholder="password" autoComplete="new-password" />
                </Form.Item>
              )}
            </>
          )
        }}
      </Form.Item>
    </>
  )

  return (
    <div className="profile-panel">
      <div className="profile-panel-header">
        <Typography.Text strong>{t('conn.title')}</Typography.Text>
        <Space size={4}>
          <Button size="small" type="text" icon={<ReloadOutlined />} onClick={onConnectionsChanged} />
          <Button size="small" type="text" icon={<DownloadOutlined />} title={t('conn.import')} onClick={importFromGonavi} />
          <Button size="small" type="primary" ghost icon={<PlusOutlined />} onClick={() => openForm('new')}>
            {t('conn.new')}
          </Button>
        </Space>
      </div>

      {profiles.length === 0 ? (
        <Empty description={t('conn.empty')} style={{ marginTop: 48 }} />
      ) : (
        <div className="conn-cards">
          {profiles.map(p => {
            const conn = connByProfile.get(p.id)
            const ready = conn?.state === 'ready'
            const pending = conn?.state === 'connecting' || conn?.state === 'needInput'
            return (
              <div key={p.id} className="conn-card">
                <div className="conn-card-head">
                  <Space size={6} className="conn-card-name">
                    <span className="conn-name">{p.name}</span>
                    <Tag bordered={false} className="conn-auth-tag">{t(`auth.${p.authMethod}`)}</Tag>
                    {(p.jumps?.length ?? 0) > 0 && (
                      <Tag bordered={false} color="geekblue" className="conn-auth-tag">{`⇢ ${p.jumps!.length}`}</Tag>
                    )}
                  </Space>
                  {ready ? (
                    <Button size="small" danger ghost className="conn-action" onClick={() => disconnect(conn!)}>
                      {t('conn.disconnect')}
                    </Button>
                  ) : (
                    <Button
                      size="small"
                      type="primary"
                      ghost
                      className="conn-action"
                      loading={pending}
                      onClick={() => onConnect(p)}
                    >
                      {t('conn.connect')}
                    </Button>
                  )}
                </div>
                <div className="conn-card-addr">
                  {p.user}@{p.host}:{p.port}
                </div>
                <div className="conn-card-foot">
                  <span className="conn-card-state">{stateBadge(conn)}</span>
                  <span className="conn-card-links">
                    <a onClick={() => openForm(p)}>{t('conn.edit')}</a>
                    <Popconfirm title={`${t('conn.delete')} ${p.name}?`} onConfirm={() => deleteProfile(p)}>
                      <a className="profile-del">{t('conn.delete')}</a>
                    </Popconfirm>
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <Modal
        title={editing === 'new' ? t('conn.new') : t('conn.edit')}
        open={editing !== null}
        onCancel={() => setEditing(null)}
        footer={[
          <Button key="test" onClick={testProfile}>{t('form.test')}</Button>,
          <Button key="cancel" onClick={() => setEditing(null)}>{t('form.cancel')}</Button>,
          <Button key="save" type="primary" onClick={saveProfile}>{t('form.save')}</Button>,
        ]}
        destroyOnClose
        width={560}
      >
        {testResult && (
          <Alert
            style={{ marginBottom: 12 }}
            showIcon
            type={testResult.ok ? 'success' : 'error'}
            message={testResult.ok ? t('form.testSuccess') : t('form.testFailed')}
            description={
              testResult.ok ? (
                <div className="test-result-detail">
                  <div>
                    {t('form.serverVersion')}: {testResult.serverVersion || '-'}
                  </div>
                  <div className="fingerprint-line">
                    {t('form.fingerprint')}: {testResult.fingerprint}
                  </div>
                </div>
              ) : (
                testResult.error
              )
            }
          />
        )}
        <Form form={form} layout="vertical" initialValues={{ authMethod: 'password', port: 22 }}>
          <Form.Item name="id" hidden><Input /></Form.Item>
          <Form.Item name="name" label={t('form.name')} rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          <Space style={{ display: 'flex' }} align="start">
            <Form.Item name="host" label={t('form.host')} rules={[{ required: true }]} style={{ flex: 1, minWidth: 200 }}>
              <Input />
            </Form.Item>
            <Form.Item name="port" label={t('form.port')}>
              <InputNumber min={1} max={65535} style={{ width: 96 }} />
            </Form.Item>
          </Space>
          <Form.Item name="user" label={t('form.user')} rules={[{ required: true }]}>
            <Input autoComplete="off" />
          </Form.Item>
          <Form.Item name="authMethod" label={t('form.authMethod')}>
            <Select options={authOptions} />
          </Form.Item>
          {authMethod === 'password' && (
            <Form.Item name="password" label={t('form.password')} extra={t('form.passwordKeep')}>
              <Input.Password autoComplete="new-password" />
            </Form.Item>
          )}
          {authMethod === 'key' && (
            <>
              <Form.Item name="keyPath" label={t('form.keyPath')} rules={[{ required: true }]}>
                <Input placeholder="C:\Users\me\.ssh\id_ed25519" />
              </Form.Item>
              <Form.Item name="passphrase" label={t('form.passphrase')} extra={t('form.passwordKeep')}>
                <Input.Password autoComplete="new-password" />
              </Form.Item>
            </>
          )}
          <Form.Item name="sudoPassword" label={t('form.sudoPassword')} extra={t('form.passwordKeep')}>
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item label={t('form.jumps')}>
            <Form.List name="jumps">
              {(fields, { add, remove }) => (
                <>
                  {fields.map(field => (
                    <div key={field.key} className="jump-row">
                      {jumpItem(field.name)}
                      <a
                        className="jump-remove"
                        onClick={() => remove(field.name)}
                      >
                        ✕
                      </a>
                    </div>
                  ))}
                  {fields.length < 3 && (
                    <Button size="small" onClick={() => add({ authMethod: 'password', port: 22 })}>
                      + {t('form.addJump')}
                    </Button>
                  )}
                </>
              )}
            </Form.List>
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
