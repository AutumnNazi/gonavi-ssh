import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Dropdown,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Typography,
  message,
} from 'antd'
import { PlusOutlined, DownloadOutlined, ReloadOutlined, MoreOutlined, EditOutlined, DeleteOutlined, DisconnectOutlined, SearchOutlined, CheckSquareOutlined, CloseOutlined, HddOutlined } from '@ant-design/icons'
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
  activeProfileId?: string
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
  activeProfileId,
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
  const advancedRef = useRef<HTMLDetailsElement>(null)
  const authMethod = Form.useWatch('authMethod', form)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [deleteTargets, setDeleteTargets] = useState<ProfileView[]>([])
  const [deleting, setDeleting] = useState(false)
  const deleteBusy = useRef(false)
  const [query, setQuery] = useState('')
  const [selectionMode, setSelectionMode] = useState(false)
  const search = query.trim().toLocaleLowerCase()
  const visibleProfiles = profiles.filter(p => `${p.name} ${p.user}@${p.host}:${p.port}`.toLocaleLowerCase().includes(search))
  const selected = visibleProfiles.filter(p => selectedIds.has(p.id))

  useEffect(() => {
    const available = new Set(profiles.map(p => p.id))
    setSelectedIds(previous => new Set([...previous].filter(id => available.has(id))))
  }, [profiles])

  const toggleSelected = (id: string, checked: boolean) => {
    if (deleteBusy.current) return
    setSelectedIds(previous => {
      const next = new Set(previous)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

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

  const validateProfile = () => form.validateFields().catch(error => {
    if (error?.errorFields?.some((field: { name?: (string | number)[] }) => field.name?.[0] === 'jumps') && advancedRef.current) advancedRef.current.open = true
    return null
  })

  const saveProfile = async () => {
    // 校验没通过时 antd 已经在字段下渲染了提示：这条拒绝不能被丢成未处理的
    // promise 拒绝（否则整个窗口会被启动期错误面板盖住），停下即可。
    const values = await validateProfile()
    if (!values) return
    try {
      const profile = { ...values }
      // A damaged encrypted chain is absent from the view, not intentionally
      // empty. Keep it unless the user supplies a replacement chain.
      if (editing && editing !== 'new' && editing.corruptJumps && !profile.jumps?.length) delete profile.jumps
      await invokeAs('profile.save', { profile })
      message.success(values.id ? t('form.save') : t('form.save'))
      setEditing(null)
      onChanged()
    } catch (e) {
      message.error(describeError(e))
    }
  }

  const testProfile = async () => {
    // 校验没通过时 antd 已经在字段下渲染了提示：这条拒绝不能被丢成未处理的
    // promise 拒绝（否则整个窗口会被启动期错误面板盖住），停下即可。
    const values = await validateProfile()
    if (!values) return
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

  const deleteProfiles = async (targets: ProfileView[]) => {
    if (deleteBusy.current || targets.length === 0) return
    deleteBusy.current = true
    setDeleting(true)
    const deleted = new Set<string>()
    const failures: string[] = []
    const active = (c: ConnectionInfo) => c.state === 'connecting' || c.state === 'needInput' || (c.state === 'ready' && c.alive !== false)
    const readConnections = async (): Promise<ConnectionInfo[]> => {
      const response = await invokeAs<{ connections: ConnectionInfo[] | null }>('conn.status', {})
      // 兼容旧插件把 Go nil 切片编码为 null；缺字段和损坏响应不能当无连接。
      if (response?.connections === null) return []
      if (!Array.isArray(response?.connections) || response.connections.some(c =>
        !c || typeof c.connectionId !== 'string' || !c.connectionId ||
        typeof c.profileId !== 'string' || !c.profileId ||
        !['connecting', 'needInput', 'ready', 'failed', 'cancelled'].includes(c.state) ||
        (c.alive !== undefined && typeof c.alive !== 'boolean')
      )) throw new Error(t('conn.statusInvalid'))
      return response.connections
    }
    try {
      for (const p of targets) {
        try {
          // 以当前后端状态为准，避免界面快照遗漏新连接或认证中的会话。
          const current = await readConnections()
          for (const c of current.filter(c => c.profileId === p.id && active(c))) {
            await invokeAs(c.state === 'ready' ? 'conn.close' : 'conn.cancel', { connectionId: c.connectionId })
          }
          const remaining = await readConnections()
          if (remaining.some(c => c.profileId === p.id && active(c))) {
            throw new Error(t('conn.deleteStillActive'))
          }
          await invokeAs('profile.delete', { id: p.id })
          deleted.add(p.id)
        } catch (e) {
          failures.push(`${p.name}: ${describeError(e)}`)
        }
      }
      setSelectedIds(previous => new Set([...previous].filter(id => !deleted.has(id))))
      if (deleted.size) message.success(t('conn.deletedCount', { count: deleted.size }))
      if (failures.length) message.error(t('conn.deleteFailedCount', { count: failures.length }) + '\n' + failures.join('\n'))
      onChanged()
      onConnectionsChanged()
    } finally {
      setDeleteTargets([])
      setDeleting(false)
      deleteBusy.current = false
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
        return <span title={t('conn.connected')} aria-label={t('conn.connected')}><Badge status="success" /></span>
      case 'connecting':
        return <span title={t('conn.connecting')} aria-label={t('conn.connecting')}><Badge status="processing" /></span>
      case 'needInput':
        return <span title={t('conn.needInput')} aria-label={t('conn.needInput')}><Badge status="warning" /></span>
      case 'failed':
        return <span title={conn.error ?? 'failed'} aria-label={conn.error ?? 'failed'}><Badge status="error" /></span>
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
          <Button size="small" type="text" icon={<PlusOutlined />} aria-label={t('conn.new')} onClick={() => openForm('new')}>{t('conn.new')}</Button>
          <Dropdown trigger={['click']} disabled={deleting} menu={{
            items: [
              { key: 'refresh', icon: <ReloadOutlined />, label: t('sftp.refresh') },
              { key: 'import', icon: <DownloadOutlined />, label: t('conn.import') },
              { key: 'select', icon: <CheckSquareOutlined />, label: t('conn.batchSelect'), disabled: profiles.length === 0 },
            ],
            onClick: ({ key }) => {
              if (deleteBusy.current) return
              if (key === 'refresh') onConnectionsChanged()
              if (key === 'import') void importFromGonavi()
              if (key === 'select') setSelectionMode(true)
            },
          }}>
            <Button size="small" type="text" icon={<MoreOutlined />} disabled={deleting} title={t('conn.actions')} aria-label={t('conn.actions')} />
          </Dropdown>
        </Space>
      </div>

      {profiles.length > 0 && <Input className="profile-search" size="small" prefix={<SearchOutlined />} allowClear
        placeholder={t('conn.search')} aria-label={t('conn.search')} value={query} disabled={deleting}
        onChange={event => { setQuery(event.target.value); setSelectedIds(new Set()) }} />}

      {selectionMode && (
        <div className="profile-selection-toolbar">
          <Checkbox
            aria-label={t('conn.selectAll')}
            checked={visibleProfiles.length > 0 && selected.length === visibleProfiles.length}
            indeterminate={selected.length > 0 && selected.length < visibleProfiles.length}
            disabled={deleting || visibleProfiles.length === 0}
            onChange={event => { if (!deleteBusy.current) setSelectedIds(event.target.checked ? new Set(visibleProfiles.map(p => p.id)) : new Set()) }}
          >{t('conn.selectAll')}</Checkbox>
          <span className="profile-selection-count">{selected.length > 0 ? t('conn.selectedCount', { count: selected.length }) : ''}</span>
          <Button size="small" type="text" danger icon={<DeleteOutlined />} disabled={deleting || selected.length === 0} title={t('conn.deleteSelected')} aria-label={t('conn.deleteSelected')} onClick={() => setDeleteTargets(selected)} />
          <Button size="small" type="text" icon={<CloseOutlined />} disabled={deleting} title={t('conn.endSelection')} aria-label={t('conn.endSelection')}
            onClick={() => { if (!deleteBusy.current) { setSelectionMode(false); setSelectedIds(new Set()) } }} />
        </div>
      )}

      {profiles.length === 0 ? (
        <Empty description={t('conn.empty')} style={{ marginTop: 48 }} />
      ) : visibleProfiles.length === 0 ? (
        <div className="profile-no-results">{t('conn.noMatches')}</div>
      ) : (
        <div className="conn-cards">
          {visibleProfiles.map(p => {
            const conn = connByProfile.get(p.id)
            const ready = conn?.state === 'ready'
            const pending = conn?.state === 'connecting' || conn?.state === 'needInput'
            return (
              <div key={p.id} className={`conn-card${ready ? ' is-connected' : ''}${p.id === activeProfileId ? ' is-active' : ''}`}>
                <div className="conn-card-head">
                  {selectionMode && <Checkbox aria-label={t('conn.selectProfile', { name: p.name })} checked={selectedIds.has(p.id)} disabled={deleting} onChange={event => toggleSelected(p.id, event.target.checked)} />}
                  <button type="button" className="conn-open" aria-label={`${t('conn.connect')} ${p.name}`} aria-current={p.id === activeProfileId || undefined} disabled={deleting || pending}
                    onClick={() => onConnect(p)}>
                    <span className="conn-symbol" aria-hidden><HddOutlined /></span>
                    <span className="conn-card-name">
                      <span className="conn-name-line"><span className="conn-name" title={p.name}>{p.name}</span>{stateBadge(conn)}</span>
                      <span className="conn-card-addr" title={`${p.user}@${p.host}:${p.port}`}>{p.user}@{p.host}{p.port === 22 ? '' : `:${p.port}`}</span>
                    </span>
                  </button>
                  {ready && (
                    <Button size="small" type="text" className="conn-action" icon={<DisconnectOutlined />} title={t('conn.disconnect')} aria-label={`${t('conn.disconnect')} ${p.name}`} disabled={deleting} onClick={() => disconnect(conn!)} />
                  )}
                  <Dropdown trigger={['click']} autoFocus disabled={deleting} menu={{
                    items: [
                      { key: 'edit', icon: <EditOutlined />, label: t('conn.edit') },
                      { key: 'delete', icon: <DeleteOutlined />, label: t('conn.delete'), danger: true },
                    ],
                    onClick: ({ key }) => {
                      if (deleteBusy.current) return
                      if (key === 'edit') openForm(p)
                      if (key === 'delete') setDeleteTargets([p])
                    },
                  }}>
                    <Button size="small" type="text" icon={<MoreOutlined />} disabled={deleting} aria-label={`${t('conn.edit')} / ${t('conn.delete')} ${p.name}`} title={`${t('conn.edit')} / ${t('conn.delete')}`} />
                  </Dropdown>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <Modal
        title={t('conn.deleteSelected')}
        open={deleteTargets.length > 0}
        onCancel={() => { if (!deleteBusy.current) setDeleteTargets([]) }}
        onOk={() => deleteProfiles(deleteTargets)}
        confirmLoading={deleting}
        okText={t('conn.deleteSelected')}
        cancelText={t('form.cancel')}
        okButtonProps={{ danger: true }}
        cancelButtonProps={{ disabled: deleting }}
        closable={!deleting}
        maskClosable={!deleting}
      >
        <p>{t('conn.deleteSelectedConfirm', { count: deleteTargets.length })}</p>
        <p>{t('conn.deleteProfilesOnly')}</p>
        <ul className="profile-delete-list">{deleteTargets.map(p => <li key={p.id}>{p.name}</li>)}</ul>
      </Modal>

      <Modal
        title={editing === 'new' ? t('conn.new') : t('conn.edit')}
        className="profile-editor"
        centered
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
        {editing && editing !== 'new' && editing.corruptSecrets && (
          <Alert type="warning" showIcon message={t('form.corruptSecrets')} style={{ marginBottom: 12 }} />
        )}
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
          <div className="profile-host-row">
            <Form.Item name="host" label={t('form.host')} rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="port" label={t('form.port')}>
              <InputNumber min={1} max={65535} style={{ width: '100%' }} />
            </Form.Item>
          </div>
          <div className="profile-auth-row">
            <Form.Item name="user" label={t('form.user')} rules={[{ required: true }]}>
              <Input autoComplete="off" />
            </Form.Item>
            <Form.Item name="authMethod" label={t('form.authMethod')}>
              <Select options={authOptions} />
            </Form.Item>
          </div>
          {authMethod === 'password' && (
            <Form.Item name="password" label={t('form.password')} extra={editing !== 'new' ? t('form.passwordKeep') : undefined}>
              <Input.Password autoComplete="new-password" />
            </Form.Item>
          )}
          {authMethod === 'key' && (
            <>
              <Form.Item name="keyPath" label={t('form.keyPath')} rules={[{ required: true }]}>
                <Input placeholder="C:\Users\me\.ssh\id_ed25519" />
              </Form.Item>
              <Form.Item name="passphrase" label={t('form.passphrase')} extra={editing !== 'new' ? t('form.passwordKeep') : undefined}>
                <Input.Password autoComplete="new-password" />
              </Form.Item>
            </>
          )}
          <details ref={advancedRef} className="profile-advanced" open={editing && editing !== 'new' && (editing.jumps?.length ?? 0) > 0 || undefined}>
            <summary>{t('form.advanced')}</summary>
            <Form.Item name="sudoPassword" label={t('form.sudoPassword')} extra={editing !== 'new' ? t('form.passwordKeep') : undefined}>
              <Input.Password autoComplete="new-password" />
            </Form.Item>
            <Form.Item label={t('form.jumps')}>
              <Form.List name="jumps">
                {(fields, { add, remove }) => (
                  <>
                    {fields.map(field => (
                      <div key={field.key} className="jump-row">
                        {jumpItem(field.name)}
                        <Button type="text" size="small" danger icon={<CloseOutlined />} aria-label={t('conn.delete')}
                          className="jump-remove"
                          onClick={() => remove(field.name)}
                        />
                      </div>
                    ))}
                    {fields.length < 3 && (
                      <Button size="small" icon={<PlusOutlined />} onClick={() => add({ authMethod: 'password', port: 22 })}>
                        {t('form.addJump')}
                      </Button>
                    )}
                  </>
                )}
              </Form.List>
            </Form.Item>
          </details>
        </Form>
      </Modal>
    </div>
  )
}
