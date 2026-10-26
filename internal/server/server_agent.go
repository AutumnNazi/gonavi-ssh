package server

import (
	"context"
	"encoding/json"

	goplugin "github.com/Syngnat/GoNavi/sdk/go"

	"gonavi-ssh/internal/sshclient"
)

// agentCommands 返回 Agent/自动化命令域。命令粒度按"人机两用"设计：
// 这些命令在插件声明 ai.tools 后会进入 GoNavi Agent 工具目录。
// exec 系列不做静态只读 gate：是否放行由 settings 的只读 exec 白名单
// 在 handler 内动态判定（只读模式下仍可跑巡检类只读命令）。
func (a *App) agentCommands() []command {
	return []command{
		{"agent.exec", false, a.agentExec},
		{"agent.execSudo", false, a.agentExecSudo},
		{"agent.execMulti", false, a.agentExecMulti},
		{"agent.runBg", true, a.agentRunBg},
		{"agent.taskStatus", false, a.agentTaskStatus},
		{"agent.taskCancel", false, a.agentTaskCancel},
		{"agent.metrics", false, a.agentMetrics},
		{"agent.triage", false, a.agentTriage},
	}
}

// gateReadOnlyExec 只读模式下的动态准入：白名单前缀放行，否则拒绝。
func (a *App) gateReadOnlyExec(command string) error {
	if a.readOnly() && !a.settings.AllowedReadOnlyExec(command) {
		return appErr(errReadOnly, "plugin is read-only and the command is not in readOnlyExecAllowlist")
	}
	return nil
}

// gateDangerous 危险命令确认门：命中模式且未带 force 时拒绝并报出
// 命中项，调用方带 force=true 重发即可执行。
func (a *App) gateDangerous(command string, force bool) error {
	if force {
		return nil
	}
	if matched := a.settings.DangerousMatch(command); matched != "" {
		return &goplugin.Error{Code: errConfirmRequired, Message: "dangerous pattern matched: " + matched + " (retry with force=true to confirm)"}
	}
	return nil
}

func (a *App) agentExec(ctx context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		ConnectionID  string `json:"connectionId"`
		Command       string `json:"command"`
		TimeoutMillis int    `json:"timeoutMillis"`
		Force         bool   `json:"force"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	if err := a.gateReadOnlyExec(req.Command); err != nil {
		return nil, err
	}
	if err := a.gateDangerous(req.Command, req.Force); err != nil {
		return nil, err
	}
	conn, ok := a.conns.Get(req.ConnectionID)
	if !ok {
		return nil, appErr(errNotFound, "connection not found or not ready")
	}
	res, err := a.agent.Exec(ctx, conn, req.Command, req.TimeoutMillis)
	if err != nil {
		return nil, appErr(errSession, err.Error())
	}
	return res, nil
}

func (a *App) agentExecSudo(ctx context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		ConnectionID  string `json:"connectionId"`
		Command       string `json:"command"`
		OtpCode       string `json:"otpCode"`
		TimeoutMillis int    `json:"timeoutMillis"`
		Force         bool   `json:"force"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	if err := a.gateReadOnlyExec(req.Command); err != nil {
		return nil, err
	}
	if err := a.gateDangerous(req.Command, req.Force); err != nil {
		return nil, err
	}
	conn, ok := a.conns.Get(req.ConnectionID)
	if !ok {
		return nil, appErr(errNotFound, "connection not found or not ready")
	}
	// Quick Sudo：档案预存的 sudo 密码自动注入（加密落盘，不回显）。
	profile, _ := a.profiles.Get(conn.ProfileID)
	sudoPassword := ""
	if profile.ID != "" {
		sudoPassword = profile.SudoPassword
	}
	res, err := a.agent.ExecSudo(ctx, conn, sudoPassword, req.OtpCode, req.Command, req.TimeoutMillis)
	if err != nil {
		return nil, appErr(errSession, err.Error())
	}
	return res, nil
}

// agent.execMulti 多主机并行执行同一命令，结果按主机汇总（≤10 台）。
func (a *App) agentExecMulti(ctx context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		ConnectionIDs []string `json:"connectionIds"`
		Command       string   `json:"command"`
		TimeoutMillis int      `json:"timeoutMillis"`
		Force         bool     `json:"force"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	if len(req.ConnectionIDs) == 0 {
		return nil, appErr(errBadArgument, "connectionIds is required")
	}
	if err := a.gateReadOnlyExec(req.Command); err != nil {
		return nil, err
	}
	if err := a.gateDangerous(req.Command, req.Force); err != nil {
		return nil, err
	}
	conns := make([]*sshclient.Conn, 0, len(req.ConnectionIDs))
	for _, id := range req.ConnectionIDs {
		if conn, ok := a.conns.Get(id); ok {
			conns = append(conns, conn)
		}
	}
	if len(conns) == 0 {
		return nil, appErr(errNotFound, "no ready connections")
	}
	results := a.agent.ExecMulti(ctx, conns, req.Command, req.TimeoutMillis)
	return map[string]any{"results": results}, nil
}

// agent.runBg 启动后台命令并立即返回（长命令适配 30s 调用期限）。
func (a *App) agentRunBg(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		ConnectionID string `json:"connectionId"`
		Command      string `json:"command"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	conn, ok := a.conns.Get(req.ConnectionID)
	if !ok {
		return nil, appErr(errNotFound, "connection not found or not ready")
	}
	taskID, err := a.agent.RunBg(conn, req.Command)
	if err != nil {
		return nil, appErr(errSession, err.Error())
	}
	return map[string]any{"taskId": taskID}, nil
}

func (a *App) agentTaskStatus(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		TaskID string `json:"taskId"`
		Offset int    `json:"offset"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	res, err := a.agent.TaskStatus(req.TaskID, req.Offset)
	if err != nil {
		return nil, appErr(errNotFound, err.Error())
	}
	return res, nil
}

func (a *App) agentTaskCancel(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		TaskID string `json:"taskId"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	if err := a.agent.TaskCancel(req.TaskID); err != nil {
		return nil, appErr(errSession, err.Error())
	}
	return map[string]any{}, nil
}

func (a *App) agentMetrics(ctx context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		ConnectionID string `json:"connectionId"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	conn, ok := a.conns.Get(req.ConnectionID)
	if !ok {
		return nil, appErr(errNotFound, "connection not found or not ready")
	}
	res, err := a.agent.Metrics(ctx, conn)
	if err != nil {
		return nil, appErr(errSession, err.Error())
	}
	return res, nil
}

func (a *App) agentTriage(ctx context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		ConnectionID string `json:"connectionId"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	conn, ok := a.conns.Get(req.ConnectionID)
	if !ok {
		return nil, appErr(errNotFound, "connection not found or not ready")
	}
	res, err := a.agent.Triage(ctx, conn)
	if err != nil {
		return nil, appErr(errSession, err.Error())
	}
	return res, nil
}
