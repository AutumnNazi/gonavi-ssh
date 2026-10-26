// Package importer 从 GoNavi 宿主的数据目录导入 SSH 信息。
// GoNavi 的数据库连接可携带 SSH 隧道配置（connections.json 内嵌
// SSHConfig）；本包只读取非敏感字段（主机/端口/用户/私钥路径）与
// 随连接明文保存的隧道密码（若宿主将其抽入系统钥匙串则导入后需补录），
// 生成插件档案。只读不写宿主文件；格式变化时容错降级。
package importer

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gonavi-ssh/internal/profile"
)

// gonaviConnections 是 connections.json 的最小化镜像：只声明需要的字段，
// 多余字段忽略（前向兼容宿主格式演进）。
type gonaviConnections struct {
	Connections []struct {
		ID     string `json:"id"`
		Name   string `json:"name"`
		Config struct {
			UseSSH bool `json:"useSSH"`
			SSH    struct {
				Host     string `json:"host"`
				Port     int    `json:"port"`
				User     string `json:"user"`
				Password string `json:"password"`
				KeyPath  string `json:"keyPath"`
			} `json:"ssh"`
		} `json:"config"`
	} `json:"connections"`
}

// Result 汇总一次导入。
type Result struct {
	Imported int      `json:"imported"`
	Skipped  int      `json:"skipped"`
	Names    []string `json:"names"`
	Root     string   `json:"root"`
}

// gonaviRoot 解析宿主数据根：显式 override（命令参数）优先，其次环境
// 变量 GONAVI_SSH_GONAVI_ROOT / GONAVI_DATA_ROOT，最后默认 ~/.gonavi。
// 宿主以受限环境启动插件进程，home 可能不可得——此时要求调用方显式
// 指定 root，而不是静默失败。
func gonaviRoot(override string) (string, error) {
	if root := strings.TrimSpace(override); root != "" {
		return root, nil
	}
	if root := strings.TrimSpace(os.Getenv("GONAVI_SSH_GONAVI_ROOT")); root != "" {
		return root, nil
	}
	if root := strings.TrimSpace(os.Getenv("GONAVI_DATA_ROOT")); root != "" {
		return root, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", fmt.Errorf("cannot resolve the GoNavi data root automatically; pass root explicitly (%w)", err)
	}
	return filepath.Join(home, ".gonavi"), nil
}

// ImportFromGonavi 扫描宿主 connections.json，把带 SSH 隧道的连接导入为
// 插件档案。已存在同名同主机的档案跳过（幂等）。rootOverride 为空时按
// 环境变量与默认路径解析宿主数据根。
func ImportFromGonavi(store *profile.Store, rootOverride string) (Result, error) {
	root, err := gonaviRoot(rootOverride)
	if err != nil {
		return Result{}, fmt.Errorf("resolve gonavi root: %w", err)
	}
	res := Result{Root: root}
	data, err := os.ReadFile(filepath.Join(root, "connections.json"))
	if errors.Is(err, os.ErrNotExist) {
		return res, nil // 宿主未初始化：静默返回空结果
	}
	if err != nil {
		return res, fmt.Errorf("read connections.json: %w", err)
	}
	var file gonaviConnections
	if err := json.Unmarshal(data, &file); err != nil {
		return res, fmt.Errorf("parse connections.json (host format changed?): %w", err)
	}

	existing := map[string]bool{}
	for _, p := range store.List() {
		existing[p.Name+"\x00"+p.Host] = true
	}
	for _, c := range file.Connections {
		ssh := c.Config.SSH
		if !c.Config.UseSSH || strings.TrimSpace(ssh.Host) == "" {
			res.Skipped++
			continue
		}
		name := strings.TrimSpace(c.Name)
		if name == "" {
			name = ssh.Host
		}
		if existing[name+"\x00"+ssh.Host] {
			res.Skipped++
			continue
		}
		method := profile.AuthPassword
		key := strings.TrimSpace(ssh.KeyPath)
		if key != "" {
			method = profile.AuthKey
		}
		p := profile.Profile{
			Name: name, Host: ssh.Host, Port: ssh.Port, User: ssh.User,
			AuthMethod: method, KeyPath: key,
			// 宿主可能把隧道密码放明文字段；为空则导入后由用户补录。
			Password: ssh.Password,
		}
		if p.User == "" {
			p.User = "root"
		}
		if err := p.Validate(); err != nil {
			res.Skipped++ // 单条无效不阻断整体
			continue
		}
		if _, err := store.Upsert(p); err != nil {
			res.Skipped++
			continue
		}
		existing[p.Name+"\x00"+p.Host] = true
		res.Imported++
		res.Names = append(res.Names, p.Name)
	}
	return res, nil
}
