package server

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strconv"

	"gonavi-ssh/internal/sftpops"
	"gonavi-ssh/internal/transfer"
)

// sftpCommands 返回文件域命令（远程 SFTP + 本地 FS + 传输任务）。
// 文件内容不过桥：预览限 256 KiB，大文件走 transfer 直传磁盘。
func (a *App) sftpCommands() []command {
	return []command{
		{"sftp.list", false, a.sftpList},
		{"sftp.stat", false, a.sftpStat},
		{"sftp.pwd", false, a.sftpPwd},
		{"sftp.mkdir", true, a.sftpMkdir},
		{"sftp.rename", true, a.sftpRename},
		{"sftp.copy", true, a.sftpCopy},
		{"sftp.chmod", true, a.sftpChmod},
		{"sftp.remove", true, a.sftpRemove},
		{"sftp.removeRecursive", true, a.sftpRemoveRecursive},
		{"sftp.preview", false, a.sftpPreview},
		{"sftp.writeFile", true, a.sftpWriteFile},
		{"sftp.du", false, a.sftpDu},
		{"knownHosts.list", false, a.knownHostsList},
		{"knownHosts.remove", true, a.knownHostsRemove},
		{"fs.listLocal", false, a.fsListLocal},
		{"transfer.start", true, a.transferStart},
		{"transfer.status", false, a.transferStatus},
		{"transfer.list", false, a.transferList},
		{"transfer.cancel", true, a.transferCancel},
		{"transfer.retry", true, a.transferRetry},
	}
}

func (a *App) sftpList(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		ConnectionID string `json:"connectionId"`
		Path         string `json:"path"`
		Offset       int    `json:"offset"`
		Limit        int    `json:"limit"`
		SortBy       string `json:"sortBy"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	conn, ok := a.conns.Get(req.ConnectionID)
	if !ok {
		return nil, appErr(errNotFound, "connection not found or not ready")
	}
	if req.Path == "" {
		req.Path = "."
	}
	switch req.SortBy {
	case "", "name", "size", "mtime":
	default:
		return nil, appErr(errBadArgument, "sortBy must be name, size or mtime")
	}
	entries, more, err := a.sftp.List(conn, req.Path, req.Offset, req.Limit, req.SortBy)
	if err != nil {
		return nil, appErr(errSession, err.Error())
	}
	return map[string]any{"entries": entries, "more": more, "path": req.Path}, nil
}

// sftp.pwd 返回远端路径的规范绝对路径。
func (a *App) sftpPwd(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		ConnectionID string `json:"connectionId"`
		Path         string `json:"path"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	conn, ok := a.conns.Get(req.ConnectionID)
	if !ok {
		return nil, appErr(errNotFound, "connection not found or not ready")
	}
	pwd, err := a.sftp.Pwd(conn, req.Path)
	if err != nil {
		return nil, appErr(errSession, err.Error())
	}
	return map[string]any{"path": pwd}, nil
}

// sftp.copy 远端服务器内复制文件（流式，不过桥）。
func (a *App) sftpCopy(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		ConnectionID string `json:"connectionId"`
		SrcPath      string `json:"srcPath"`
		DstPath      string `json:"dstPath"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	conn, ok := a.conns.Get(req.ConnectionID)
	if !ok {
		return nil, appErr(errNotFound, "connection not found or not ready")
	}
	if err := a.sftp.Copy(conn, req.SrcPath, req.DstPath); err != nil {
		return nil, appErr(errSession, err.Error())
	}
	return map[string]any{}, nil
}

// knownHosts.list 列出全部已信任主机（地址+指纹+类型）。
func (a *App) knownHostsList(_ context.Context, raw json.RawMessage) (any, error) {
	if err := requireNoArgs(raw); err != nil {
		return nil, err
	}
	return map[string]any{"hosts": a.conns.KnownHosts()}, nil
}

// knownHosts.remove 删除一条信任记录（主机换机后重录）。
func (a *App) knownHostsRemove(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		Addr string `json:"addr"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	if req.Addr == "" {
		return nil, appErr(errBadArgument, "addr is required")
	}
	if !a.conns.RemoveKnownHost(req.Addr) {
		return nil, appErr(errNotFound, "known host not found")
	}
	return map[string]any{}, nil
}

func (a *App) sftpStat(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		ConnectionID string `json:"connectionId"`
		Path         string `json:"path"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	conn, ok := a.conns.Get(req.ConnectionID)
	if !ok {
		return nil, appErr(errNotFound, "connection not found or not ready")
	}
	entry, err := a.sftp.Stat(conn, req.Path)
	if err != nil {
		return nil, appErr(errSession, err.Error())
	}
	return map[string]any{"entry": entry}, nil
}

func (a *App) sftpMkdir(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		ConnectionID string `json:"connectionId"`
		Path         string `json:"path"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	conn, ok := a.conns.Get(req.ConnectionID)
	if !ok {
		return nil, appErr(errNotFound, "connection not found or not ready")
	}
	if err := a.sftp.Mkdir(conn, req.Path); err != nil {
		return nil, appErr(errSession, err.Error())
	}
	return map[string]any{}, nil
}

func (a *App) sftpRename(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		ConnectionID string `json:"connectionId"`
		OldPath      string `json:"oldPath"`
		NewPath      string `json:"newPath"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	conn, ok := a.conns.Get(req.ConnectionID)
	if !ok {
		return nil, appErr(errNotFound, "connection not found or not ready")
	}
	if err := a.sftp.Rename(conn, req.OldPath, req.NewPath); err != nil {
		return nil, appErr(errSession, err.Error())
	}
	return map[string]any{}, nil
}

func (a *App) sftpChmod(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		ConnectionID string `json:"connectionId"`
		Path         string `json:"path"`
		Mode         string `json:"mode"` // 八进制字符串，如 "644"
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	conn, ok := a.conns.Get(req.ConnectionID)
	if !ok {
		return nil, appErr(errNotFound, "connection not found or not ready")
	}
	mode, err := strconv.ParseUint(req.Mode, 8, 32)
	if err != nil {
		return nil, appErr(errBadArgument, "mode must be octal like 644")
	}
	if err := a.sftp.Chmod(conn, req.Path, uint32(mode)); err != nil {
		return nil, appErr(errSession, err.Error())
	}
	return map[string]any{}, nil
}

func (a *App) sftpRemove(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		ConnectionID string `json:"connectionId"`
		Path         string `json:"path"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	conn, ok := a.conns.Get(req.ConnectionID)
	if !ok {
		return nil, appErr(errNotFound, "connection not found or not ready")
	}
	if err := a.sftp.Remove(conn, req.Path); err != nil {
		return nil, appErr(errSession, err.Error())
	}
	return map[string]any{}, nil
}

func (a *App) sftpRemoveRecursive(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		ConnectionID string `json:"connectionId"`
		Path         string `json:"path"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	conn, ok := a.conns.Get(req.ConnectionID)
	if !ok {
		return nil, appErr(errNotFound, "connection not found or not ready")
	}
	if err := a.sftp.RemoveRecursive(conn, req.Path); err != nil {
		return nil, appErr(errSession, err.Error())
	}
	return map[string]any{}, nil
}

// sftp.preview 读小文件内容（≤256 KiB），base64 返回。
func (a *App) sftpPreview(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		ConnectionID string `json:"connectionId"`
		Path         string `json:"path"`
		MaxBytes     int64  `json:"maxBytes"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	conn, ok := a.conns.Get(req.ConnectionID)
	if !ok {
		return nil, appErr(errNotFound, "connection not found or not ready")
	}
	data, err := a.sftp.ReadPreview(conn, req.Path, req.MaxBytes)
	if err != nil {
		return nil, appErr(errSession, err.Error())
	}
	return map[string]any{"dataBase64": base64.StdEncoding.EncodeToString(data), "bytes": len(data)}, nil
}

// sftp.writeFile 写小文件（编辑器保存场景）；大文件走 transfer。
func (a *App) sftpWriteFile(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		ConnectionID string `json:"connectionId"`
		Path         string `json:"path"`
		DataBase64   string `json:"dataBase64"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	conn, ok := a.conns.Get(req.ConnectionID)
	if !ok {
		return nil, appErr(errNotFound, "connection not found or not ready")
	}
	content, err := base64.StdEncoding.DecodeString(req.DataBase64)
	if err != nil {
		return nil, appErr(errBadArgument, "dataBase64 is not valid base64")
	}
	if err := a.sftp.WriteFile(conn, req.Path, content); err != nil {
		return nil, appErr(errSession, err.Error())
	}
	return map[string]any{"bytes": len(content)}, nil
}

// sftp.du 磁盘用量（依赖服务器 statvfs 扩展）。
func (a *App) sftpDu(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		ConnectionID string `json:"connectionId"`
		Path         string `json:"path"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	conn, ok := a.conns.Get(req.ConnectionID)
	if !ok {
		return nil, appErr(errNotFound, "connection not found or not ready")
	}
	usage, err := a.sftp.DiskUsage(conn, req.Path)
	if err != nil {
		return nil, appErr(errSession, err.Error())
	}
	return usage, nil
}

// fs.listLocal 列本地目录（path 空时返回盘符/根 + 用户目录）。
func (a *App) fsListLocal(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		Path string `json:"path"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	if req.Path != "" && !a.settings.AllowLocalPath(req.Path) {
		return nil, appErr(errBadArgument, "path is outside the configured localPathAllowlist")
	}
	entries, err := sftpops.ListLocal(req.Path)
	if err != nil {
		return nil, appErr(errSession, err.Error())
	}
	return map[string]any{"entries": entries, "home": sftpops.LocalHome()}, nil
}

// ---------- transfer ----------

func (a *App) transferStart(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		ConnectionID       string `json:"connectionId"`
		Direction          string `json:"direction"`
		RemotePath         string `json:"remotePath"`
		LocalPath          string `json:"localPath"`
		TargetConnectionID string `json:"targetConnectionId"`
		TargetPath         string `json:"targetPath"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	dir := transfer.Direction(req.Direction)
	switch dir {
	case transfer.Upload, transfer.Download:
		// 本地直传磁盘路径（见下）。
	case transfer.ServerToServer:
		src, ok := a.conns.Get(req.ConnectionID)
		if !ok {
			return nil, appErr(errNotFound, "source connection not found or not ready")
		}
		dst, ok := a.conns.Get(req.TargetConnectionID)
		if !ok {
			return nil, appErr(errNotFound, "target connection not found or not ready")
		}
		task, err := a.transfers.StartRemote(src, req.RemotePath, dst, req.TargetPath)
		if err != nil {
			return nil, appErr(errBadArgument, err.Error())
		}
		return map[string]any{"taskId": task.ID}, nil
	default:
		return nil, appErr(errBadArgument, "direction must be upload, download or serverToServer")
	}
	conn, ok := a.conns.Get(req.ConnectionID)
	if !ok {
		return nil, appErr(errNotFound, "connection not found or not ready")
	}
	if !a.settings.AllowLocalPath(req.LocalPath) {
		return nil, appErr(errBadArgument, "localPath is outside the configured localPathAllowlist")
	}
	task, err := a.transfers.Start(conn, dir, req.RemotePath, req.LocalPath)
	if err != nil {
		return nil, appErr(errBadArgument, err.Error())
	}
	return map[string]any{"taskId": task.ID}, nil
}

func (a *App) transferStatus(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		TaskID string `json:"taskId"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	st, ok := a.transfers.Status(req.TaskID)
	if !ok {
		return nil, appErr(errNotFound, "task not found")
	}
	return st, nil
}

func (a *App) transferList(_ context.Context, raw json.RawMessage) (any, error) {
	if err := requireNoArgs(raw); err != nil {
		return nil, err
	}
	return map[string]any{"tasks": a.transfers.List()}, nil
}

func (a *App) transferCancel(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		TaskID string `json:"taskId"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	if err := a.transfers.Cancel(req.TaskID); err != nil {
		return nil, appErr(errSession, err.Error())
	}
	return map[string]any{}, nil
}

func (a *App) transferRetry(_ context.Context, raw json.RawMessage) (any, error) {
	var req struct {
		TaskID       string `json:"taskId"`
		ConnectionID string `json:"connectionId"`
	}
	if err := decode(raw, &req); err != nil {
		return nil, err
	}
	conn, ok := a.conns.Get(req.ConnectionID)
	if !ok {
		return nil, appErr(errNotFound, "connection not found or not ready")
	}
	newID, err := a.transfers.Retry(req.TaskID, conn)
	if err != nil {
		return nil, appErr(errSession, err.Error())
	}
	return map[string]any{"taskId": newID}, nil
}
