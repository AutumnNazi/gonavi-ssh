// Package settings 管理插件运行配置：只读模式、sudo 白名单、快速命令。
// 落盘 settings.json（非敏感，明文 JSON）；只读模式可被环境变量
// GONAVI_SSH_READ_ONLY=1 强制开启且不可通过命令关闭。
package settings

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
)

// QuickCommand 是用户自定义的快捷命令（名称 + 待发送命令行）。
type QuickCommand struct {
	Name    string `json:"name"`
	Command string `json:"command"`
}

// Settings 是插件全部可持久化配置。
type Settings struct {
	// ReadOnly 开启后所有写效果命令（写文件/改目录/exec 等）一律拒绝。
	ReadOnly bool `json:"readOnly"`
	// ReadOnlyExecAllowlist：只读模式下仍放行的 agent.exec 命令前缀
	//（巡检类只读命令，如 uptime/free -m），对齐"只读连接可跑巡检"语义。
	ReadOnlyExecAllowlist []string `json:"readOnlyExecAllowlist"`
	// SudoAllowlist 是允许 agent.execSudo 执行的 sudo 命令前缀。
	SudoAllowlist []string `json:"sudoAllowlist"`
	// QuickCommands 快速命令列表（终端工具栏按钮）。
	QuickCommands []QuickCommand `json:"quickCommands"`
	// DangerousPatterns：危险命令确认门——agent.exec/execSudo/execMulti
	// 的命令命中任一子串时需携带 force=true 二次确认，否则拒绝。
	DangerousPatterns []string `json:"dangerousPatterns,omitempty"`
	// LocalPathAllowlist：本地路径边界。空=不限制；非空时 transfer 与
	// 本地浏览的路径必须命中任一前缀（分隔符不敏感）。
	LocalPathAllowlist []string `json:"localPathAllowlist,omitempty"`
	// CwdFollow：目录跟随。开启后新终端自动注入 OSC7 上报钩子
	//（bash/zsh），文件面板跟随终端 cd。nil（未配置）视为关闭。
	CwdFollow *bool `json:"cwdFollow,omitempty"`
	// HistoryLimit 每会话命令历史保留条数；HistoryEnabled=nil（未配置）
	// 视为开启，显式 false 完全不记录。指针用于区分"未设置"与"显式关闭"。
	HistoryLimit   int   `json:"historyLimit"`
	HistoryEnabled *bool `json:"historyEnabled,omitempty"`
}

// HistoryOn 报告命令历史是否启用（未配置视为开）。
func (s Settings) HistoryOn() bool { return s.HistoryEnabled == nil || *s.HistoryEnabled }

// CwdFollowOn 报告目录跟随是否启用（未配置视为关）。
func (s Settings) CwdFollowOn() bool { return s.CwdFollow != nil && *s.CwdFollow }

// Default 返回缺省配置。
func Default() Settings {
	return Settings{
		SudoAllowlist: []string{"systemctl status", "journalctl", "tail", "cat", "df", "free", "uptime", "ls"},
		HistoryLimit:  500,
	}
}

// Store 提供 settings.json 的读写与强制只读合并。
type Store struct {
	mu       sync.Mutex
	path     string
	current  Settings
	forcedRO bool // 环境变量强制只读，优先于文件配置
}

// Open 加载配置；文件不存在时写回缺省值。
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}
	s := &Store{
		path:     filepath.Join(dir, "settings.json"),
		current:  Default(),
		forcedRO: os.Getenv("GONAVI_SSH_READ_ONLY") == "1",
	}
	data, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		if werr := s.persist(); werr != nil {
			return nil, werr
		}
		return s, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read settings: %w", err)
	}
	if len(data) > 0 {
		var loaded Settings
		if err := json.Unmarshal(data, &loaded); err != nil {
			return nil, fmt.Errorf("parse settings: %w", err)
		}
		s.current = mergeDefaults(loaded)
	}
	return s, nil
}

// mergeDefaults 补齐零值字段（老配置升级）；HistoryEnabled 保持指针
// 语义：nil（未配置）由 HistoryOn 解释为开启，不在此强制覆盖。
func mergeDefaults(s Settings) Settings {
	def := Default()
	if s.HistoryLimit <= 0 {
		s.HistoryLimit = def.HistoryLimit
	}
	if s.SudoAllowlist == nil {
		s.SudoAllowlist = def.SudoAllowlist
	}
	if s.QuickCommands == nil {
		s.QuickCommands = []QuickCommand{}
	}
	return s
}

// Get 返回生效配置（合并强制只读）。
func (s *Store) Get() Settings {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := s.current
	if s.forcedRO {
		out.ReadOnly = true
	}
	return out
}

// Update 应用配置；slice 字段传 nil 表示"不修改"（部分更新语义），
// 非 nil（含空数组）按传入值整体替换。强制只读下拒绝关闭只读。
func (s *Store) Update(next Settings) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.forcedRO {
		if !next.ReadOnly {
			return errors.New("read-only mode is forced by environment")
		}
	}
	// 部分更新：nil 的列表沿用当前值，避免调用方漏传字段被重置。
	if next.SudoAllowlist == nil {
		next.SudoAllowlist = s.current.SudoAllowlist
	}
	if next.ReadOnlyExecAllowlist == nil {
		next.ReadOnlyExecAllowlist = s.current.ReadOnlyExecAllowlist
	}
	if next.QuickCommands == nil {
		next.QuickCommands = s.current.QuickCommands
	}
	if next.DangerousPatterns == nil {
		next.DangerousPatterns = s.current.DangerousPatterns
	}
	if next.LocalPathAllowlist == nil {
		next.LocalPathAllowlist = s.current.LocalPathAllowlist
	}
	if next.HistoryEnabled == nil {
		next.HistoryEnabled = s.current.HistoryEnabled
	}
	if next.CwdFollow == nil {
		next.CwdFollow = s.current.CwdFollow
	}
	next = mergeDefaults(next)
	s.current = next
	return s.persist()
}

func (s *Store) persist() error {
	data, err := json.MarshalIndent(s.current, "", "  ")
	if err != nil {
		return err
	}
	tmp := s.path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, s.path)
}

// AllowedSudo 判断命令是否命中 sudo 白名单前缀；白名单命令同时拒绝
// shell 元字符（;&|`$() 等）——前缀匹配挡不住 "cat x; rm -rf /"。
func (s *Store) AllowedSudo(command string) bool {
	if strings.ContainsAny(command, ";&|`$()<>\\\n") {
		return false
	}
	st := s.Get()
	cmd := strings.TrimSpace(command)
	for _, prefix := range st.SudoAllowlist {
		prefix = strings.TrimSpace(prefix)
		if prefix == "" {
			continue
		}
		if cmd == prefix || strings.HasPrefix(cmd, prefix+" ") {
			return true
		}
	}
	return false
}

// DangerousMatch 返回命中的第一个危险模式（未命中返回空）。
func (s *Store) DangerousMatch(command string) string {
	for _, pattern := range s.Get().DangerousPatterns {
		pattern = strings.TrimSpace(pattern)
		if pattern != "" && strings.Contains(command, pattern) {
			return pattern
		}
	}
	return ""
}

// AllowLocalPath 判断本地路径是否在边界内（空名单=不限制）。
// 除字面路径外还解析符号链接/junction 后的真实路径再比较，防止
// 白名单内的链接把实际访问带出边界。解析失败（路径尚不存在）时
// 回落到解析父目录 + 文件名。
func (s *Store) AllowLocalPath(path string) bool {
	allow := s.Get().LocalPathAllowlist
	if len(allow) == 0 {
		return true
	}
	if matchesPrefixes(path, allow) {
		// 字面命中仍要验证最终落点（若可解析），防止 symlink 穿透。
		if resolved, err := resolveWritePath(path); err == nil {
			return matchesPrefixes(resolved, allow)
		}
		return true
	}
	if resolved, err := resolveWritePath(path); err == nil {
		return matchesPrefixes(resolved, allow)
	}
	return false
}

// resolveWritePath 解析写入路径的最终落点。与 EvalSymlinks 不同，它
// 会沿失效符号链接的 Readlink 目标继续解析——否则预置的 dangling
// 链接会让 O_CREATE 在白名单外创建并写入文件。
func resolveWritePath(path string) (string, error) {
	return resolveWritePathDepth(path, 0)
}

func resolveWritePathDepth(path string, depth int) (string, error) {
	if depth > 10 {
		return "", errors.New("too many symlink levels")
	}
	if fi, err := os.Lstat(path); err == nil && fi.Mode()&os.ModeSymlink != 0 {
		target, err := os.Readlink(path)
		if err != nil {
			return "", err
		}
		if !filepath.IsAbs(target) {
			target = filepath.Join(filepath.Dir(path), target)
		}
		return resolveWritePathDepth(target, depth+1)
	}
	return resolveRealPath(path)
}

func matchesPrefixes(path string, allow []string) bool {
	normalized := normalizeLocalPath(path)
	for _, prefix := range allow {
		prefix = normalizeLocalPath(strings.TrimSpace(prefix))
		if prefix != "" && (normalized == prefix ||
			strings.HasPrefix(normalized, prefix+string(filepath.Separator)) ||
			strings.HasPrefix(normalized, prefix+"/")) {
			return true
		}
	}
	return false
}

// resolveRealPath 返回路径解析符号链接/junction 后的真实路径；
// 路径不存在时解析其父目录再接回文件名。
func resolveRealPath(path string) (string, error) {
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		return resolved, nil
	}
	parent := filepath.Dir(path)
	if parent == path {
		return "", errors.New("cannot resolve path")
	}
	resolvedParent, err := filepath.EvalSymlinks(parent)
	if err != nil {
		return "", err
	}
	return filepath.Join(resolvedParent, filepath.Base(path)), nil
}

// normalizeLocalPath 统一分隔符做前缀比较（Windows 大小写不敏感盘符）。
func normalizeLocalPath(p string) string {
	p = filepath.Clean(strings.TrimSpace(p))
	p = strings.ReplaceAll(p, "/", string(filepath.Separator))
	if runtime.GOOS == "windows" {
		return strings.ToLower(p)
	}
	return p
}

// AllowedReadOnlyExec 判断只读模式下是否放行该 exec 命令。
// 与 sudo 白名单一致地拒绝 shell 元字符：前缀匹配挡不住
// "uptime ; touch x" 这类拼接。
func (s *Store) AllowedReadOnlyExec(command string) bool {
	st := s.Get()
	if !st.ReadOnly {
		return true // 非只读无需检查
	}
	if strings.ContainsAny(command, ";&|`$()<>\\\n") {
		return false
	}
	cmd := strings.TrimSpace(command)
	for _, prefix := range st.ReadOnlyExecAllowlist {
		prefix = strings.TrimSpace(prefix)
		if prefix == "" {
			continue
		}
		if cmd == prefix || strings.HasPrefix(cmd, prefix+" ") {
			return true
		}
	}
	return false
}
