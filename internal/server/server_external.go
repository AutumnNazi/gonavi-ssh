package server

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"

	"gonavi-ssh/internal/sshclient"
)

// openExternalMaxBytes 是「用本机程序打开」愿意同步拖下来的上限。这条路径是同步的：
// 几百 MB 的文件会把窗口卡到没响应，超了就让用户走下载队列。
const openExternalMaxBytes = 64 << 20

// openExternalDir 是抓下来的远端文件在本机落脚的地方（数据目录下的 opened/）。
const openExternalDir = "opened"

// systemOpener 真正去唤起系统默认程序。抽成变量只为测试：用例里真弹一个编辑器
// 出来会让它又慢又不受控，而这条路径本身没什么可断言的。
var systemOpener = openWithSystem

// sftp.openExternal 把远端文件取到本机临时目录，再交给系统默认程序打开。
//
// 打开之后的改动不会自动回写远端：保存了要由用户显式上传（transfer.start）。
// 自动回写得常驻盯文件变化，而"在编辑器里随手存一下就把远端覆盖掉"这种惊吓，
// 代价比多点一次上传大得多。每次打开都重新拉取远端当前内容。
func (a *App) sftpOpenExternal(_ context.Context, raw json.RawMessage) (any, error) {
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
	if entry.IsDir {
		return nil, appErr(errBadArgument, "only files can be opened with a local program")
	}
	if entry.Size > openExternalMaxBytes {
		return nil, appErr(errBadArgument, fmt.Sprintf(
			"file is %d bytes, over the %d byte limit for opening locally; download it instead",
			entry.Size, openExternalMaxBytes))
	}

	local, err := a.fetchToOpenedDir(req.ConnectionID, conn, req.Path, entry.Name)
	if err != nil {
		return nil, appErr(errSession, err.Error())
	}
	if err := systemOpener(local); err != nil {
		return nil, appErr(errSession, err.Error())
	}
	return map[string]any{"localPath": local, "bytes": entry.Size}, nil
}

// fetchToOpenedDir 把远端文件拉到 opened/ 下。同一个连接上的同一个远端路径固定映射到
// 同一个本机文件，用户上传回远端时找得到它，也不会在临时目录里堆一地同名副本。
func (a *App) fetchToOpenedDir(connectionID string, conn *sshclient.Conn, remotePath, name string) (string, error) {
	client, err := a.sftp.Client(conn)
	if err != nil {
		return "", err
	}
	src, err := client.Open(remotePath)
	if err != nil {
		return "", fmt.Errorf("open remote file: %w", err)
	}
	defer src.Close()
	return a.writeOpenedFile(connectionID, remotePath, name, src)
}

// writeOpenedFile 把远端内容落到 opened/ 下。抽成独立方法是为了能直接喂一个 Reader
// 测大小上限与半截文件清理——用例里不必真起一台 SFTP 服务器。
func (a *App) writeOpenedFile(connectionID, remotePath, name string, src io.Reader) (string, error) {
	dir := filepath.Join(a.dataDir, openExternalDir)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("create opened dir: %w", err)
	}
	target := filepath.Join(dir, localNameFor(connectionID, remotePath, name))

	dst, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return "", fmt.Errorf("create local file: %w", err)
	}
	// 大小以 Stat 为准，但它可能过时（远端正在写这个文件）：LimitReader 多读一个
	// 字节即说明超限，此时删掉半截文件——不能把残缺内容交给系统程序打开。
	written, copyErr := io.Copy(dst, io.LimitReader(src, openExternalMaxBytes+1))
	closeErr := dst.Close()
	if copyErr != nil {
		os.Remove(target)
		return "", fmt.Errorf("fetch remote file: %w", copyErr)
	}
	if closeErr != nil {
		os.Remove(target)
		return "", fmt.Errorf("flush local file: %w", closeErr)
	}
	if written > openExternalMaxBytes {
		os.Remove(target)
		return "", fmt.Errorf("file grew past the %d byte limit while being fetched", openExternalMaxBytes)
	}
	return target, nil
}

// localNameFor 由「连接 + 远端路径」派生本机文件名：哈希在前保证唯一（不同机器上的
// /etc/hosts 不会串成一个），原始文件名留在后面，用户在编辑器标题栏里仍认得出它。
func localNameFor(connectionID, remotePath, name string) string {
	sum := sha256.Sum256([]byte(connectionID + "\x00" + remotePath))
	safe := strings.Map(func(r rune) rune {
		switch r {
		case '/', '\\', ':', '*', '?', '"', '<', '>', '|', 0:
			return '_'
		}
		return r
	}, name)
	if safe == "" || safe == "." || safe == ".." {
		safe = "file"
	}
	return hex.EncodeToString(sum[:8]) + "-" + safe
}

// openWithSystem 用系统默认程序打开本机文件，不等它退出（编辑器是长驻进程）。
func openWithSystem(path string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		// start 是 cmd 内置命令，第一个带引号的参数会被当成窗口标题：必须给个空串
		// 占位，否则带空格的路径会被当成标题，结果是弹出一个空窗口。
		cmd = exec.Command("cmd", "/c", "start", "", path)
	case "darwin":
		cmd = exec.Command("open", path)
	default:
		cmd = exec.Command("xdg-open", path)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("launch system opener: %w", err)
	}
	go func() { _ = cmd.Wait() }()
	return nil
}
