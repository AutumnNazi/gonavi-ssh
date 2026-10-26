package profile

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func openTempStore(t *testing.T) *Store {
	t.Helper()
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	return s
}

// 密码与口令必须加密落盘：文件字节里不得出现明文。
func TestStoreEncryptsSecretsOnDisk(t *testing.T) {
	s := openTempStore(t)
	_, err := s.Upsert(Profile{
		Name: "prod", Host: "10.0.0.1", Port: 22, User: "root",
		AuthMethod: AuthPassword, Password: "s3cret-pass", Passphrase: "pp-live",
	})
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	data, rerr := os.ReadFile(filepath.Join(s.dir, profilesFile))
	if rerr != nil {
		t.Fatalf("read profiles.json: %v", rerr)
	}
	if strings.Contains(string(data), "s3cret-pass") || strings.Contains(string(data), "pp-live") {
		t.Fatal("plaintext secret leaked into profiles.json")
	}
}

// 重新打开存储后敏感字段必须能解密回来。
func TestStoreReopenDecrypts(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	saved, err := s.Upsert(Profile{
		Name: "db", Host: "db.local", User: "admin",
		AuthMethod: AuthPassword, Password: "hunter2",
	})
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}

	again, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	got, ok := again.Get(saved.ID)
	if !ok {
		t.Fatal("profile missing after reopen")
	}
	if got.Password != "hunter2" {
		t.Fatalf("password not restored: %q", got.Password)
	}
	if got.Sanitized().HasPassword != true {
		t.Fatal("sanitized view should report hasPassword")
	}
}

// 更新留空密码时沿用旧值；显式新密码覆盖旧值。
func TestStoreUpsertKeepsBlankSecrets(t *testing.T) {
	s := openTempStore(t)
	first, err := s.Upsert(Profile{
		Name: "a", Host: "h", User: "u", AuthMethod: AuthPassword, Password: "old",
	})
	if err != nil {
		t.Fatalf("upsert1: %v", err)
	}
	second, err := s.Upsert(Profile{
		ID: first.ID, Name: "a", Host: "h2", User: "u", AuthMethod: AuthPassword,
	})
	if err != nil {
		t.Fatalf("upsert2: %v", err)
	}
	if second.Password != "old" {
		t.Fatalf("blank update should keep old password, got %q", second.Password)
	}
	third, err := s.Upsert(Profile{
		ID: first.ID, Name: "a", Host: "h2", User: "u", AuthMethod: AuthPassword, Password: "new",
	})
	if err != nil {
		t.Fatalf("upsert3: %v", err)
	}
	if third.Password != "new" {
		t.Fatalf("explicit update should replace password, got %q", third.Password)
	}
}

func TestStoreDelete(t *testing.T) {
	s := openTempStore(t)
	p, _ := s.Upsert(Profile{Name: "x", Host: "h", User: "u", AuthMethod: AuthAgent})
	if err := s.Delete(p.ID); err != nil {
		t.Fatalf("delete: %v", err)
	}
	if _, ok := s.Get(p.ID); ok {
		t.Fatal("profile still present after delete")
	}
}

func TestProfileValidate(t *testing.T) {
	cases := []struct {
		name    string
		p       Profile
		wantErr bool
	}{
		{"missing name", Profile{Host: "h", User: "u", AuthMethod: AuthAgent}, true},
		{"missing host", Profile{Name: "n", User: "u", AuthMethod: AuthAgent}, true},
		{"missing user", Profile{Name: "n", Host: "h", AuthMethod: AuthAgent}, true},
		{"bad method", Profile{Name: "n", Host: "h", User: "u", AuthMethod: "nope"}, true},
		{"key without path", Profile{Name: "n", Host: "h", User: "u", AuthMethod: AuthKey}, true},
		{"bad port", Profile{Name: "n", Host: "h", User: "u", AuthMethod: AuthAgent, Port: 99999}, true},
		{"ok agent", Profile{Name: "n", Host: "h", User: "u", AuthMethod: AuthAgent}, false},
		{"ok password", Profile{Name: "n", Host: "h", User: "u", AuthMethod: AuthPassword}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.p.Validate()
			if (err != nil) != tc.wantErr {
				t.Fatalf("Validate() err=%v wantErr=%v", err, tc.wantErr)
			}
		})
	}
}

// Sanitized 不得泄露敏感明文。
func TestSanitizedHidesSecrets(t *testing.T) {
	p := Profile{
		ID: "1", Name: "n", Host: "h", Port: 0, User: "u",
		AuthMethod: AuthPassword, Password: "SECRET-PW-123", Passphrase: "SECRET-PP-456",
		UpdatedAt: time.Now(),
	}
	sv := p.Sanitized()
	if sv.HasPassword != true || sv.HasPassphrase != true {
		t.Fatal("has flags wrong")
	}
	if sv.Port != 22 {
		t.Fatalf("default port expected 22, got %d", sv.Port)
	}
	b, err := json.Marshal(sv)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(b), "SECRET-PW-123") || strings.Contains(string(b), "SECRET-PP-456") {
		t.Fatal("sanitized json contains secrets")
	}
}

// sudo 密码加密落盘往返 + 更新留空沿用。
func TestSudoPasswordRoundTrip(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	_, err := s.Upsert(Profile{
		Name: "n", Host: "h", User: "u", AuthMethod: AuthPassword,
		Password: "ssh-pw", SudoPassword: "sudo-pw",
	})
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	again, _ := Open(dir)
	list := again.List()
	if len(list) != 1 || list[0].SudoPassword != "sudo-pw" {
		t.Fatalf("sudo password lost: %+v", list)
	}
	if !list[0].Sanitized().HasSudoPassword {
		t.Fatal("sanitized view must report hasSudoPassword")
	}
	data, _ := os.ReadFile(filepath.Join(dir, profilesFile))
	if strings.Contains(string(data), "sudo-pw") {
		t.Fatal("sudo password leaked in plaintext")
	}
}

// 跳板密码与口令必须进入加密存储（重启后仍可解密）。
func TestJumpSecretsPersistEncrypted(t *testing.T) {
	dir := t.TempDir()
	s, _ := Open(dir)
	_, err := s.Upsert(Profile{
		Name: "n", Host: "h", User: "u", AuthMethod: AuthPassword, Password: "pw",
		Jumps: []Jump{{
			Host: "jump", Port: 22, User: "ops", AuthMethod: AuthPassword,
			Password: "jump-pw", Passphrase: "jump-pp",
		}},
	})
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	again, _ := Open(dir)
	list := again.List()
	if len(list) != 1 || len(list[0].Jumps) != 1 {
		t.Fatalf("jumps lost: %+v", list)
	}
	j := list[0].Jumps[0]
	if j.Password != "jump-pw" || j.Passphrase != "jump-pp" {
		t.Fatalf("jump secrets lost: %+v", j)
	}
	data, _ := os.ReadFile(filepath.Join(dir, profilesFile))
	if strings.Contains(string(data), "jump-pw") {
		t.Fatal("jump password leaked in plaintext")
	}
}
