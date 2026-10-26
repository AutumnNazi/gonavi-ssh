package settings

import (
	"os"
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
