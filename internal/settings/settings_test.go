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

// 本地回显：未配置保持 nil（前端按开启处理），显式关闭要落盘，
// 且后续只改其他字段的部分更新不能把它顶回默认。
func TestLocalEchoPersistence(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	if s.Get().LocalEcho != nil {
		t.Fatalf("unset local echo must stay nil, got %v", *s.Get().LocalEcho)
	}
	off := false
	if err := s.Update(Settings{LocalEcho: &off}); err != nil {
		t.Fatalf("update: %v", err)
	}
	if err := s.Update(Settings{ReadOnly: true}); err != nil {
		t.Fatalf("partial update: %v", err)
	}
	reopened, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	got := reopened.Get().LocalEcho
	if got == nil || *got {
		t.Fatalf("localEcho=false must survive a partial update and a reload, got %v", got)
	}
}

// 文件树：显示开关未配置视为显示（与 localEcho/historyEnabled 一致），
// 命令跳转映射要落盘，且部分更新不能把两者顶回默认。
func TestFileTreeSettings(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	if s.Get().ShowFileTree != nil {
		t.Fatalf("unset showFileTree must stay nil, got %v", *s.Get().ShowFileTree)
	}
	hide := false
	jumps := []TreeCommand{{Name: "logs", Path: "/var/log"}, {Name: "app", Path: "/opt/app"}}
	if err := s.Update(Settings{ShowFileTree: &hide, TreeCommands: jumps}); err != nil {
		t.Fatalf("update: %v", err)
	}
	if err := s.Update(Settings{ReadOnly: true}); err != nil {
		t.Fatalf("partial update: %v", err)
	}
	reopened, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	got := reopened.Get()
	if got.ShowFileTree == nil || *got.ShowFileTree {
		t.Fatalf("showFileTree=false must survive a partial update and a reload, got %v", got.ShowFileTree)
	}
	if len(got.TreeCommands) != 2 || got.TreeCommands[0].Name != "logs" || got.TreeCommands[1].Path != "/opt/app" {
		t.Fatalf("tree commands lost on reload: %+v", got.TreeCommands)
	}
	// 显式清空映射要能落下去（空切片不等于"没传"）。
	if err := s.Update(Settings{TreeCommands: []TreeCommand{}}); err != nil {
		t.Fatalf("clear: %v", err)
	}
	if len(s.Get().TreeCommands) != 0 {
		t.Fatalf("explicit empty list must clear the mapping, got %+v", s.Get().TreeCommands)
	}
}

// 终端页三个可选开关（目录跟随、本地回显、文件浏览）的缺省语义统一为「关」：
// 未配置就是关。用户没开过的功能不该在他不知情时自己亮起来——跟随还要往远端
// shell 注入钩子，默认开等于替用户动了远端。
func TestOptionalSwitchesDefaultOff(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	got := s.Get()
	if got.CwdFollowOn() || got.LocalEchoOn() || got.ShowFileTreeOn() {
		t.Fatalf("unset switches must read as off, got cwd=%v echo=%v tree=%v",
			got.CwdFollowOn(), got.LocalEchoOn(), got.ShowFileTreeOn())
	}
	on := true
	if err := s.Update(Settings{CwdFollow: &on, LocalEcho: &on, ShowFileTree: &on}); err != nil {
		t.Fatalf("update: %v", err)
	}
	// 只改别的字段的部分更新不能把刚打开的三个开关顶回关闭。
	if err := s.Update(Settings{ReadOnly: true}); err != nil {
		t.Fatalf("partial update: %v", err)
	}
	reopened, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	got = reopened.Get()
	if !got.CwdFollowOn() || !got.LocalEchoOn() || !got.ShowFileTreeOn() {
		t.Fatalf("explicitly enabled switches must survive a partial update and a reload, got cwd=%v echo=%v tree=%v",
			got.CwdFollowOn(), got.LocalEchoOn(), got.ShowFileTreeOn())
	}
}

// 下载目录：文件浏览面板下载文件的落点，由宿主原生目录选择器挑一次后记住。
// 没设过（nil）与"设为空串"要能区分——后者是用户主动清掉。
func TestDownloadDirPersistence(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	if s.Get().DownloadDir != nil {
		t.Fatalf("unset download dir must stay nil, got %q", *s.Get().DownloadDir)
	}
	downloads := `D:\drops`
	if err := s.Update(Settings{DownloadDir: &downloads}); err != nil {
		t.Fatalf("update: %v", err)
	}
	if err := s.Update(Settings{ReadOnly: true}); err != nil {
		t.Fatalf("partial update: %v", err)
	}
	reopened, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	got := reopened.Get().DownloadDir
	if got == nil || *got != downloads {
		t.Fatalf("download dir must survive a partial update and a reload, got %v", got)
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
