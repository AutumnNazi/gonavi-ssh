// Package server 把各模块组装成 GoNavi 插件命令（plugin.invoke）。
// 命令只做参数解码、模块调用与响应编码；错误一律转成不含敏感信息的
// *plugin.Error。只读模式开启时，写效果命令统一拒绝。
package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
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
	profiles  *profile.Store
	conns     *sshclient.Manager
	terms     *terminal.Manager
	sftp      *sftpops.Manager
	transfers *transfer.Manager
	agent     *agentcmd.Manager
	settings  *settings.Store
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
		profiles:  store,
		conns:     conns,
		settings:  st,
		sftp:      sftpMgr,
		transfers: transfer.NewManager(sftpMgr),
		agent:     agentcmd.NewManager(st),
	}
	app.terms = terminal.NewManager(st.Get().HistoryLimit)
	// 连接自然死亡（keepalive 失败）时联动清理绑定的 sftp client。
	conns.OnDead(func(connectionID string) { sftpMgr.Close(connectionID) })
	return app, nil
}

// Shutdown 由 SDK OnClose 调用：非阻塞地关闭全部会话与连接。
func (a *App) Shutdown() {
	a.terms.CloseAll()
	a.transfers.CloseAll()
	a.sftp.CloseAll()
	a.conns.CloseAll()
}

// readOnly 查询当前是否只读模式。
func (a *App) readOnly() bool { return a.settings.Get().ReadOnly }

// command 是命令表条目：write 为 true 的命令在只读模式下被拒绝。
type command struct {
	id      string
	write   bool
	handler goplugin.Handler
}

// Handlers 返回命令注册表：每条命令带效果标注，写命令在只读模式下拒绝。
func (a *App) Handlers() map[string]goplugin.Handler {
	table := []command{
		// profile
		{"profile.list", false, a.profileList},
		{"profile.save", true, a.profileSave},
		{"profile.delete", true, a.profileDelete},
		{"profile.test", false, a.profileTest},
		{"profile.importFromGonavi", true, a.profileImport},
		// settings
		{"settings.get", false, a.settingsGet},
		// settings.set 不走只读 gate：否则只读一旦开启就无法关闭。
		// 环境变量强制只读的场景由 settings.Store 自行拒绝关闭。
		{"settings.set", false, a.settingsSet},
		// conn（两段式连接）
		{"conn.open", true, a.connOpen},
		{"conn.answer", true, a.connAnswer},
		{"conn.cancel", true, a.connCancel},
		{"conn.status", false, a.connStatus},
		{"conn.close", true, a.connClose},
		{"session.teardown", true, a.sessionTeardown},
		// terminal
		{"terminal.open", true, a.terminalOpen},
		{"terminal.write", true, a.terminalWrite},
		{"terminal.writeMulti", true, a.terminalWriteMulti},
		{"terminal.read", false, a.terminalRead},
		{"terminal.resize", true, a.terminalResize},
		{"terminal.close", true, a.terminalClose},
		{"terminal.list", false, a.terminalList},
		{"terminal.history", false, a.terminalHistory},
	}
	table = append(table, a.sftpCommands()...)
	table = append(table, a.agentCommands()...)

	handlers := make(map[string]goplugin.Handler, len(table))
	for _, c := range table {
		h := c.handler
		if c.write {
			id := c.id
			h = func(ctx context.Context, raw json.RawMessage) (any, error) {
				if a.readOnly() {
					return nil, appErr(errReadOnly, "plugin is in read-only mode: "+id+" is a write command")
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
	if err := a.settings.Update(req.Settings); err != nil {
		return nil, appErr(errBadArgument, err.Error())
	}
	return map[string]any{"settings": a.settings.Get()}, nil
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
	a.terms.CloseAll()
	a.transfers.CloseAll()
	a.sftp.CloseAll()
	a.conns.CloseAll()
	return map[string]any{}, nil
}

// ---------- terminal ----------

func (a *App) terminalOpen(_ context.Context, raw json.RawMessage) (any, error) {
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
	sess, err := a.terms.Open(conn, req.Cols, req.Rows)
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
