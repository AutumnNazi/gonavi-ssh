// Package server 把各模块组装成 GoNavi 插件命令（plugin.invoke）。
// 命令只做参数解码、模块调用与响应编码；错误一律转成不含敏感信息的
// *plugin.Error。只读模式开启时，写效果命令统一拒绝。
package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"sync"
	"time"

	goplugin "github.com/Syngnat/GoNavi/sdk/go"

	"gonavi-ssh/internal/agentcmd"
	"gonavi-ssh/internal/importer"
	"gonavi-ssh/internal/profile"
	"gonavi-ssh/internal/settings"
	"gonavi-ssh/internal/sftpops"
	"gonavi-ssh/internal/sshclient"
	"gonavi-ssh/internal/terminal"
	"gonavi-ssh/internal/transfer"
)

// 应用错误码：JSON-RPC 保留段之外的插件自定义段。
const (
	errBadArgument     = 4100
	errNotFound        = 4101
	errConnFailed      = 4102
	errSession         = 4103
	errInternal        = 4199
	errReadOnly        = 4201
	errConfirmRequired = 4202 // 危险命令需 force=true 二次确认
)

// maxWaitMillis 长轮询上限：宿主独立窗口桥的调用期限是 30s，留 5s 裕量。
const maxWaitMillis = 25000

// App 汇集插件全部运行时状态。
type App struct {
	// dataDir 插件私有数据目录：「用本机程序打开」抓下来的远端文件落在它的
	// opened/ 下，和设置、档案同处一地，进程退出也不会跑到别处去。
	dataDir    string
	profiles   *profile.Store
	conns      *sshclient.Manager
	terms      *terminal.Manager
	sftp       *sftpops.Manager
	transfers  *transfer.Manager
	agent      *agentcmd.Manager
	settings   *settings.Store
	settingsMu sync.Mutex // commits settings and live history policy in the same order
}

// New 用数据目录构造 App。
func New(dataDir string) (*App, error) {
	store, err := profile.Open(dataDir)
	if err != nil {
		return nil, err
	}
	conns, err := sshclient.NewManager(dataDir)
	if err != nil {
		return nil, err
	}
	st, err := settings.Open(dataDir)
	if err != nil {
		return nil, err
	}
	sftpMgr := sftpops.NewManager()
	app := &App{
		dataDir:   dataDir,
		profiles:  store,
		conns:     conns,
		settings:  st,
		sftp:      sftpMgr,
		transfers: transfer.NewManager(sftpMgr),
		agent:     agentcmd.NewManager(st),
	}
	app.terms = terminal.NewManager(st.Get().HistoryLimit)
	app.terms.SetHistory(st.Get().HistoryOn(), st.Get().HistoryLimit)
	// 连接自然死亡（keepalive 失败）时联动清理绑定的 sftp client。
	conns.OnDead(func(connectionID string) { sftpMgr.Close(connectionID) })
	return app, nil
}

// Shutdown 由 SDK OnClose 调用：非阻塞地关闭全部会话与连接。
func (a *App) Shutdown() {
	// 进程退出路径：不限时，等清理干净再走。
	runTeardown(0, a.closeAllSessions()...)
}

// readOnly 查询当前是否只读模式。
func (a *App) readOnly() bool { return a.settings.Get().ReadOnly }

// command 是命令表条目：write 为 true 的命令在只读模式下被拒绝。
type command struct {
	id string
	// readOnlyBlocked 标记"只读模式下直接拒绝"的命令。只读模式的定位是限制
	// AI Agent 执行任意命令的能力，不是把插件锁成砖头——人工通道（连接、终端、
	// 文件、档案）一律不受它影响，所以表里几乎没有命令落在这一档上。
	// Agent 的 exec 系列连静态 gate 都不走，由 settings 的巡检白名单在 handler
	// 内动态判定（见 server_agent.go）。
	readOnlyBlocked bool
	handler         goplugin.Handler
}

// Handlers 返回命令注册表。只读模式只作用于 Agent 通道：人工怎么用都不受影响。
func (a *App) Handlers() map[string]goplugin.Handler {
	table := []command{
		// profile：档案的增删改是人工操作。
		{"profile.list", false, a.profileList},
		{"profile.save", false, a.profileSave},
		{"profile.delete", false, a.profileDelete},
		{"profile.test", false, a.profileTest},
		{"profile.importFromGonavi", false, a.profileImport},
		// settings
		{"settings.get", false, a.settingsGet},
		// settings.set 不走只读 gate：否则只读一旦开启就无法关闭。
		// 环境变量强制只读的场景由 settings.Store 自行拒绝关闭。
		{"settings.set", false, a.settingsSet},
		// conn：建立连接与应答认证是人工的实时操作。
		{"conn.open", false, a.connOpen},
		{"conn.answer", false, a.connAnswer},
		// 清理类命令（无远端副作用）。
		{"conn.cancel", false, a.connCancel},
		{"conn.status", false, a.connStatus},
		{"conn.close", false, a.connClose},
		// 关窗清理：必须放行，否则连接会残留到进程退出。
		{"session.teardown", false, a.sessionTeardown},
		// terminal：终端是人工手打的通道，用户自己敲的命令由他自己负责。
		{"terminal.open", false, a.terminalOpen},
		{"terminal.write", false, a.terminalWrite},
		{"terminal.writeMulti", false, a.terminalWriteMulti},
		{"terminal.read", false, a.terminalRead},
		{"terminal.readMulti", false, a.terminalReadMulti},
		{"terminal.resize", false, a.terminalResize},
		{"terminal.close", false, a.terminalClose},
		{"terminal.list", false, a.terminalList},
		{"terminal.history", false, a.terminalHistory},
	}
	table = append(table, a.sftpCommands()...)
	table = append(table, a.agentCommands()...)

	handlers := make(map[string]goplugin.Handler, len(table))
	for _, c := range table {
		h := c.handler
		if c.readOnlyBlocked {
			id := c.id
			h = func(ctx context.Context, raw json.RawMessage) (any, error) {
				if a.readOnly() {
					return nil, appErr(errReadOnly, "plugin is in read-only mode: "+id+" is not available")
				}
				return c.handler(ctx, raw)
			}
		}
		handlers[c.id] = h
	}
	return handlers
}

// ---------- settings ----------

func (a *App) settingsGet(_ context.Context, raw json.RawMessage) (any, error) {
	if err := requireNoArgs(raw); err != nil {
		return nil, err
	}
	return map[string]any{"settings": a.settings.Get()}, nil
}

func (a *App) settingsSet(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		Settings settings.Settings `json:"settings"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	a.settingsMu.Lock()
	defer a.settingsMu.Unlock()
	if err := a.settings.Update(req.Settings); err != nil {
		return nil, appErr(errBadArgument, err.Error())
	}
	current := a.settings.Get()
	a.terms.SetHistory(current.HistoryOn(), current.HistoryLimit)
	return map[string]any{"settings": current}, nil
}

// ---------- profile ----------

type jumpInput struct {
	Host       string `json:"host"`
	Port       int    `json:"port"`
	User       string `json:"user"`
	AuthMethod string `json:"authMethod"`
	KeyPath    string `json:"keyPath"`
	Password   string `json:"password"`
	Passphrase string `json:"passphrase"`
}

type profileInput struct {
	ID           string      `json:"id"`
	Name         string      `json:"name"`
	Host         string      `json:"host"`
	Port         int         `json:"port"`
	User         string      `json:"user"`
	AuthMethod   string      `json:"authMethod"`
	KeyPath      string      `json:"keyPath"`
	Password     string      `json:"password"`
	Passphrase   string      `json:"passphrase"`
	SudoPassword string      `json:"sudoPassword"`
	Jumps        []jumpInput `json:"jumps"`
}

func (in profileInput) toProfile() profile.Profile {
	p := profile.Profile{
		ID: in.ID, Name: in.Name, Host: in.Host, Port: in.Port, User: in.User,
		AuthMethod: profile.AuthMethod(in.AuthMethod), KeyPath: in.KeyPath,
		Password: in.Password, Passphrase: in.Passphrase, SudoPassword: in.SudoPassword,
	}
	if in.Jumps != nil {
		p.Jumps = make([]profile.Jump, 0, len(in.Jumps))
		for _, j := range in.Jumps {
			p.Jumps = append(p.Jumps, profile.Jump{
				Host: j.Host, Port: j.Port, User: j.User,
				AuthMethod: profile.AuthMethod(j.AuthMethod), KeyPath: j.KeyPath,
				Password: j.Password, Passphrase: j.Passphrase,
			})
		}
	}
	return p
}

func (a *App) profileList(_ context.Context, raw json.RawMessage) (any, error) {
	if err := requireNoArgs(raw); err != nil {
		return nil, err
	}
	list := a.profiles.List()
	out := make([]profile.Sanitized, 0, len(list))
	for _, p := range list {
		out = append(out, p.Sanitized())
	}
	return map[string]any{"profiles": out}, nil
}

func (a *App) profileSave(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		Profile profileInput `json:"profile"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	saved, err := a.profiles.Upsert(req.Profile.toProfile())
	if err != nil {
		return nil, appErr(errBadArgument, err.Error())
	}
	return map[string]any{"profile": saved.Sanitized()}, nil
}

func (a *App) profileDelete(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		ID string `json:"id"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	if req.ID == "" {
		return nil, appErr(errBadArgument, "id is required")
	}
	if err := a.profiles.Delete(req.ID); err != nil {
		return nil, appErr(errInternal, "delete failed")
	}
	return map[string]any{}, nil
}

// profile.test 验证档案可连通（不交互；需要双因素时请走 conn.open 流程）。
func (a *App) profileTest(ctx context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		ProfileID string        `json:"profileId"`
		Profile   *profileInput `json:"profile"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	var target profile.Profile
	switch {
	case req.ProfileID != "":
		p, ok := a.profiles.Get(req.ProfileID)
		if !ok {
			return nil, appErr(errNotFound, "profile not found")
		}
		target = p
	case req.Profile != nil:
		if saved, ok := a.profiles.Get(req.Profile.ID); ok && saved.CorruptSecrets {
			return nil, appErr(errBadArgument, "stored credentials cannot be decrypted; save repaired credentials before testing")
		}
		target = req.Profile.toProfile()
		if err := target.Validate(); err != nil {
			return nil, appErr(errBadArgument, err.Error())
		}
	default:
		return nil, appErr(errBadArgument, "profileId or profile is required")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	info, err := a.conns.TestDial(target)
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}, nil
	}
	return map[string]any{
		"ok":            true,
		"fingerprint":   info.Fingerprint,
		"serverVersion": info.ServerVersion,
	}, nil
}

// profile.importFromGonavi 从宿主 connections.json 导入 SSH 隧道信息
// （非敏感字段；只读宿主文件，幂等）。
func (a *App) profileImport(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		Root string `json:"root"`
	}
	trimmed := strings.TrimSpace(string(raw))
	if trimmed != "" && trimmed != "null" && trimmed != "{}" {
		if err := json.Unmarshal(raw, &req); err != nil {
			return nil, appErr(errBadArgument, "invalid arguments")
		}
	}
	res, err := importer.ImportFromGonavi(a.profiles, req.Root)
	if err != nil {
		return nil, appErr(errSession, err.Error())
	}
	return res, nil
}

// ---------- conn（两段式：open 立即返回，status 轮询，answer 交互应答） ----------

func (a *App) connOpen(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		ProfileID string `json:"profileId"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	p, ok := a.profiles.Get(req.ProfileID)
	if !ok {
		return nil, appErr(errNotFound, "profile not found")
	}
	st := a.conns.OpenBegin(p)
	if st.State == "failed" && st.Error != "" {
		return nil, appErr(errConnFailed, st.Error)
	}
	return st, nil
}

func (a *App) connAnswer(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		ConnectionID string   `json:"connectionId"`
		Answers      []string `json:"answers"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	if err := a.conns.Answer(req.ConnectionID, req.Answers); err != nil {
		return nil, appErr(errConnFailed, err.Error())
	}
	return map[string]any{}, nil
}

func (a *App) connCancel(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		ConnectionID string `json:"connectionId"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	a.conns.CancelPending(req.ConnectionID)
	return map[string]any{}, nil
}

func (a *App) connStatus(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		ConnectionID string `json:"connectionId"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	return map[string]any{"connections": a.conns.Status(req.ConnectionID)}, nil
}

func (a *App) connClose(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		ConnectionID string `json:"connectionId"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	if req.ConnectionID == "" {
		return nil, appErr(errBadArgument, "connectionId is required")
	}
	a.conns.CloseByID(req.ConnectionID)
	a.sftp.Close(req.ConnectionID)
	return map[string]any{}, nil
}

// session.teardown 关闭本插件进程内全部终端会话、传输任务与 SSH 连接。
// 宿主在插件窗口关闭时调用，避免重开窗口后残留无法管理的后台连接。
func (a *App) sessionTeardown(_ context.Context, raw json.RawMessage) (any, error) {
	if err := requireNoArgs(raw); err != nil {
		return nil, err
	}
	// 并行 + 限时：宿主在本次调用返回前不允许重开插件窗口，串行等待每一次
	// 关连接的网络收尾会把「关窗后马上重开」堵住。
	runTeardown(teardownGrace, a.closeAllSessions()...)
	return map[string]any{}, nil
}

// ---------- terminal ----------

func (a *App) terminalOpen(ctx context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		ConnectionID string `json:"connectionId"`
		Cols         int    `json:"cols"`
		Rows         int    `json:"rows"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	conn, ok := a.conns.Get(req.ConnectionID)
	if !ok {
		return nil, appErr(errNotFound, "connection not found or not ready")
	}
	sess, err := a.terms.Open(ctx, conn, req.Cols, req.Rows)
	if err != nil {
		return nil, appErr(errSession, err.Error())
	}
	cols, rows := sess.Size()
	return map[string]any{"sessionKey": sess.Key, "cols": cols, "rows": rows}, nil
}

func (a *App) terminalWrite(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		SessionKey string `json:"sessionKey"`
		DataBase64 string `json:"dataBase64"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	n, err := a.writeSession(req.SessionKey, req.DataBase64)
	if err != nil {
		return nil, err
	}
	return map[string]any{"written": n}, nil
}

// terminal.writeMulti 向多个会话广播同一输入（批量输入）。
func (a *App) terminalWriteMulti(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		SessionKeys []string `json:"sessionKeys"`
		DataBase64  string   `json:"dataBase64"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	if len(req.SessionKeys) == 0 {
		return nil, appErr(errBadArgument, "sessionKeys is required")
	}
	written := map[string]any{}
	for _, key := range req.SessionKeys {
		n, err := a.writeSession(key, req.DataBase64)
		if err != nil {
			written[key] = err.Error()
			continue
		}
		written[key] = n
	}
	return map[string]any{"written": written}, nil
}

func (a *App) writeSession(key, dataB64 string) (int, error) {
	sess, ok := a.terms.Get(key)
	if !ok {
		return 0, appErr(errNotFound, "session not found")
	}
	data, err := base64.StdEncoding.DecodeString(dataB64)
	if err != nil {
		return 0, appErr(errBadArgument, "dataBase64 is not valid base64")
	}
	n, err := sess.Write(data)
	if err != nil {
		return 0, appErr(errSession, err.Error())
	}
	return n, nil
}

// terminal.read 长轮询：无数据时最多阻塞 waitMillis（上限 25s），
// 宿主取消（$/cancelRequest）会传播成 ctx 取消立即返回。
func (a *App) terminalRead(ctx context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		SessionKey string `json:"sessionKey"`
		MaxBytes   int    `json:"maxBytes"`
		WaitMillis int    `json:"waitMillis"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	sess, ok := a.terms.Get(req.SessionKey)
	if !ok {
		// 会话已结束并被摘除：报告 eof，让 UI 停止轮询。
		return map[string]any{"dataBase64": "", "eof": true, "hasExit": false}, nil
	}
	if req.WaitMillis < 0 {
		req.WaitMillis = 0
	}
	if req.WaitMillis > maxWaitMillis {
		req.WaitMillis = maxWaitMillis
	}
	chunk, eof, exitCode, hasExit, err := sess.Read(ctx, req.MaxBytes, time.Duration(req.WaitMillis)*time.Millisecond)
	if err != nil {
		return nil, appErr(errSession, err.Error())
	}
	resp := map[string]any{
		"dataBase64": base64.StdEncoding.EncodeToString(chunk),
		"eof":        eof,
		"hasExit":    hasExit,
	}
	if hasExit {
		resp["exitCode"] = exitCode
	}
	return resp, nil
}

// terminal.readMulti 批量长轮询：一次调用服务多个会话，任一会话有输出或
// 已结束就返回。前端所有终端标签共用一条读取循环，不再各占一个宿主桥并发
// 额度（上限 8），标签数量因此不再影响输入写入。
func (a *App) terminalReadMulti(ctx context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		SessionKeys []string `json:"sessionKeys"`
		MaxBytes    int      `json:"maxBytes"`
		WaitMillis  int      `json:"waitMillis"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	if len(req.SessionKeys) == 0 {
		return nil, appErr(errBadArgument, "sessionKeys is required")
	}
	if req.WaitMillis < 0 {
		req.WaitMillis = 0
	}
	if req.WaitMillis > maxWaitMillis {
		req.WaitMillis = maxWaitMillis
	}
	events, err := a.terms.ReadMulti(ctx, req.SessionKeys, req.MaxBytes, time.Duration(req.WaitMillis)*time.Millisecond)
	if err != nil {
		return nil, appErr(errSession, err.Error())
	}
	out := make([]map[string]any, 0, len(events))
	for _, ev := range events {
		item := map[string]any{
			"sessionKey": ev.SessionKey,
			"dataBase64": base64.StdEncoding.EncodeToString(ev.Chunk),
			"eof":        ev.EOF,
			"hasExit":    ev.HasExit,
		}
		if ev.HasExit {
			item["exitCode"] = ev.ExitCode
		}
		out = append(out, item)
	}
	return map[string]any{"events": out}, nil
}

func (a *App) terminalResize(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		SessionKey string `json:"sessionKey"`
		Cols       int    `json:"cols"`
		Rows       int    `json:"rows"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	sess, ok := a.terms.Get(req.SessionKey)
	if !ok {
		return nil, appErr(errNotFound, "session not found")
	}
	if err := sess.Resize(req.Cols, req.Rows); err != nil {
		return nil, appErr(errSession, err.Error())
	}
	return map[string]any{}, nil
}

func (a *App) terminalClose(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		SessionKey string `json:"sessionKey"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	a.terms.CloseByKey(req.SessionKey)
	return map[string]any{}, nil
}

func (a *App) terminalList(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		ConnectionID string `json:"connectionId"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	return map[string]any{"sessions": a.terms.List(req.ConnectionID)}, nil
}

// terminal.history 返回会话命令行历史（亡会话也可查）。
func (a *App) terminalHistory(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		SessionKey string `json:"sessionKey"`
		Limit      int    `json:"limit"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	sess, ok := a.terms.Get(req.SessionKey)
	if !ok {
		return nil, appErr(errNotFound, "session not found")
	}
	return map[string]any{"lines": sess.History(req.Limit)}, nil
}

// ---------- helpers ----------

// decode 解析命令参数；空 body 报参数错误而不是静默零值。
func decode(raw json.RawMessage, target any) error {
	if len(raw) == 0 || string(raw) == "null" {
		return appErr(errBadArgument, "arguments are required")
	}
	if err := json.Unmarshal(raw, target); err != nil {
		return appErr(errBadArgument, "invalid arguments")
	}
	return nil
}

// requireNoArgs 用于无参命令：容忍空/{}，拒绝其他载荷。
func requireNoArgs(raw json.RawMessage) error {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" || trimmed == "{}" {
		return nil
	}
	return appErr(errBadArgument, "command takes no arguments")
}

func appErr(code int, msg string) *goplugin.Error {
	return &goplugin.Error{Code: code, Message: msg}
}
