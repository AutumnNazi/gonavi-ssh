package settings

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSudoAllowlist(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	cases := []struct {
		cmd  string
		want bool
	}{
		{"systemctl status nginx", true},
		{"systemctl stop nginx", false}, // stop 不在白名单
		{"systemctl", false},            // 裸命令不匹配带参前缀（避免进交互模式）
		{"tail -f /var/log/syslog", true},
		{"tailx -f", false}, // 前缀必须按词匹配
		{"rm -rf /", false},
		{"cat /etc/shadow", true},
	}
	for _, c := range cases {
		if got := s.AllowedSudo(c.cmd); got != c.want {
			t.Errorf("AllowedSudo(%q)=%v want %v", c.cmd, got, c.want)
		}
	}
}

func TestForcedReadOnly(t *testing.T) {
	t.Setenv("GONAVI_SSH_READ_ONLY", "1")
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if !s.Get().ReadOnly {
		t.Fatal("environment must force read-only")
	}
	// 关闭只读的更新必须被拒绝。
	next := s.Get()
	next.ReadOnly = false
	if err := s.Update(next); err == nil {
		t.Fatal("update clearing forced read-only must fail")
	}
	_ = os.Stdout
}

// 部分更新：nil slice 沿用当前值，非 nil 替换。
func TestUpdatePartialMerge(t *testing.T) {
	s, _ := Open(t.TempDir())
	base := s.Get()
	base.SudoAllowlist = []string{"cat"}
	base.QuickCommands = []QuickCommand{{Name: "n", Command: "c"}}
	if err := s.Update(base); err != nil {
		t.Fatalf("seed: %v", err)
	}
	// 只改 readOnly，其余 nil。
	if err := s.Update(Settings{ReadOnly: true}); err != nil {
		t.Fatalf("update: %v", err)
	}
	got := s.Get()
	if !got.ReadOnly {
		t.Fatal("readOnly not applied")
	}
	if len(got.SudoAllowlist) != 1 || got.SudoAllowlist[0] != "cat" {
		t.Fatalf("sudo allowlist reset: %v", got.SudoAllowlist)
	}
	if len(got.QuickCommands) != 1 {
		t.Fatalf("quick commands reset: %v", got.QuickCommands)
	}
}

// 只读白名单放行/拒绝。
func TestAllowedReadOnlyExec(t *testing.T) {
	s, _ := Open(t.TempDir())
	// 非只读：一律放行。
	if !s.AllowedReadOnlyExec("rm -rf /") {
		t.Fatal("non-readonly must allow everything")
	}
	base := s.Get()
	base.ReadOnly = true
	base.ReadOnlyExecAllowlist = []string{"uptime", "free"}
	if err := s.Update(base); err != nil {
		t.Fatalf("update: %v", err)
	}
	if !s.AllowedReadOnlyExec("uptime") || !s.AllowedReadOnlyExec("free -m") {
		t.Fatal("allowlisted commands must pass")
	}
	if s.AllowedReadOnlyExec("rm -rf /") {
		t.Fatal("non-allowlisted command must be rejected in read-only mode")
	}
}

// sudo 白名单拒绝 shell 元字符（前缀匹配挡不住 "cat x; cmd"）。
func TestSudoAllowlistRejectsMetachars(t *testing.T) {
	s, _ := Open(t.TempDir())
	if s.AllowedSudo("cat /etc/shadow; rm -rf /") {
		t.Fatal("metachar command must be rejected")
	}
	if s.AllowedSudo("cat $(whoami)") || s.AllowedSudo("cat a | b") {
		t.Fatal("substitution/pipe must be rejected")
	}
	if !s.AllowedSudo("cat /etc/shadow") {
		t.Fatal("plain allowlisted command must pass")
	}
}

// 危险模式命中与 force 语义。
func TestDangerousMatch(t *testing.T) {
	s, _ := Open(t.TempDir())
	base := s.Get()
	base.DangerousPatterns = []string{"rm -rf", "mkfs", "dd if="}
	if err := s.Update(base); err != nil {
		t.Fatalf("update: %v", err)
	}
	if m := s.DangerousMatch("sudo rm -rf /"); m != "rm -rf" {
		t.Fatalf("match=%q", m)
	}
	if s.DangerousMatch("ls /") != "" {
		t.Fatal("clean command must not match")
	}
}

// 本地路径边界：空=全放；前缀命中放行；盘符大小写与分隔符不敏感。
func TestAllowLocalPath(t *testing.T) {
	s, _ := Open(t.TempDir())
	if !s.AllowLocalPath("C:/anywhere/secret") {
		t.Fatal("empty allowlist must permit everything")
	}
	base := s.Get()
	base.LocalPathAllowlist = []string{`C:\Users\me\downloads`, "/tmp"}
	if err := s.Update(base); err != nil {
		t.Fatalf("update: %v", err)
	}
	cases := []struct {
		path string
		want bool
	}{
		{`C:\Users\me\downloads\a.zip`, true},
		{"C:/users/ME/downloads/sub/a.zip", true},
		{"/tmp/x", true},
		{`C:\Users\other\x`, false},
		{`C:\Users\me2\x`, false}, // 前缀必须按段匹配
		{"", false},
	}
	for _, c := range cases {
		if got := s.AllowLocalPath(c.path); got != c.want {
			t.Errorf("AllowLocalPath(%q)=%v want %v", c.path, got, c.want)
		}
	}
}

// 只读 exec 白名单必须拒绝 shell 元字符（前缀匹配挡不住命令拼接）。
func TestReadOnlyExecRejectsMetachars(t *testing.T) {
	s, _ := Open(t.TempDir())
	base := s.Get()
	base.ReadOnly = true
	base.ReadOnlyExecAllowlist = []string{"uptime"}
	if err := s.Update(base); err != nil {
		t.Fatalf("update: %v", err)
	}
	if s.AllowedReadOnlyExec("uptime ; touch /tmp/x") {
		t.Fatal("metachar command must be rejected")
	}
	if s.AllowedReadOnlyExec("uptime && rm -rf /") {
		t.Fatal("and-chain must be rejected")
	}
	if !s.AllowedReadOnlyExec("uptime") {
		t.Fatal("plain allowlisted command must pass")
	}
}

// 本地路径边界必须解析符号链接：白名单内的链接指向外部时拒绝。
func TestAllowLocalPathRejectsSymlinkEscape(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "allowed")
	outside := filepath.Join(root, "outside")
	if err := os.MkdirAll(inside, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(inside, "escape")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	s, _ := Open(t.TempDir())
	base := s.Get()
	base.LocalPathAllowlist = []string{inside}
	if err := s.Update(base); err != nil {
		t.Fatalf("update: %v", err)
	}
	if !s.AllowLocalPath(filepath.Join(inside, "ok.txt")) {
		t.Fatal("path inside allowlist must pass")
	}
	if s.AllowLocalPath(filepath.Join(link, "secret.txt")) {
		t.Fatal("symlink escape must be rejected")
	}
}

// 失效符号链接（dangling）也必须拦截：O_CREATE 会沿链接在白名单外创建文件。
func TestAllowLocalPathRejectsDanglingSymlink(t *testing.T) {
	root := t.TempDir()
	inside := filepath.Join(root, "allowed")
	outside := filepath.Join(root, "outside")
	if err := os.MkdirAll(inside, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	// 指向白名单外一个尚不存在的文件。
	link := filepath.Join(inside, "newfile")
	if err := os.Symlink(filepath.Join(outside, "victim.txt"), link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	s, _ := Open(t.TempDir())
	base := s.Get()
	base.LocalPathAllowlist = []string{inside}
	if err := s.Update(base); err != nil {
		t.Fatalf("update: %v", err)
	}
	if s.AllowLocalPath(link) {
		t.Fatal("dangling symlink escaping the allowlist must be rejected")
	}
	for _, suffix := range []string{".part", ".part.meta"} {
		sidecar := link + suffix
		if !s.AllowLocalPath(sidecar) {
			t.Fatal("independent sidecar path inside the allowlist must pass")
		}
		if err := os.Symlink(filepath.Join(outside, "victim.txt"), sidecar); err != nil {
			t.Fatal(err)
		}
		if s.AllowLocalPath(sidecar) {
			t.Fatal("actual sidecar symlink escaping the allowlist must be rejected")
		}
	}
}
