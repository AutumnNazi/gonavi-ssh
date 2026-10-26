// gonavi-ssh 插件后端入口：stdin/stdout 上的 JSON-RPC 协议服务。
// 数据目录默认 ~/.gonavi-ssh，可用 GONAVI_SSH_HOME 覆盖（测试友好）。
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"

	goplugin "github.com/Syngnat/GoNavi/sdk/go"

	"gonavi-ssh/internal/server"
)

func main() {
	if err := run(); err != nil {
		// 协议要求 stdout 只能走协议帧，诊断一律写 stderr。
		fmt.Fprintln(os.Stderr, "gonavi-ssh:", err)
		os.Exit(1)
	}
}

// resolveDataDir 决定插件数据目录。优先级：
//  1. GONAVI_SSH_HOME —— 测试/独立运行覆盖
//  2. GONAVI_PLUGIN_DATA —— 宿主为每个插件分配的私有数据目录
//     （宿主以受限环境启动插件进程，USERPROFILE 等变量不可见，
//     不能依赖 os.UserHomeDir；此前依赖它导致进程启动即退出）
//  3. 独立运行兜底：用户目录 ~/.gonavi-ssh
func resolveDataDir() (string, error) {
	if dir := strings.TrimSpace(os.Getenv("GONAVI_SSH_HOME")); dir != "" {
		return dir, nil
	}
	if dir := strings.TrimSpace(os.Getenv("GONAVI_PLUGIN_DATA")); dir != "" {
		return dir, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("no data directory: set GONAVI_SSH_HOME (%w)", err)
	}
	return filepath.Join(home, ".gonavi-ssh"), nil
}

func run() error {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	dataDir, err := resolveDataDir()
	if err != nil {
		return err
	}

	app, err := server.New(dataDir)
	if err != nil {
		return fmt.Errorf("init app: %w", err)
	}

	srv := goplugin.NewServer(goplugin.Options{
		Handlers: app.Handlers(),
		// 非阻塞清理：关闭全部 PTY 与 SSH 连接，不等待远端响应。
		OnClose: app.Shutdown,
	})
	return srv.ServeStdio(ctx)
}
