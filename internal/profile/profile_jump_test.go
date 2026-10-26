package profile

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEditKeepsSecretsForDistinctJumpKeys(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	first, err := s.Upsert(Profile{
		Name: "before", Host: "target", User: "user", AuthMethod: AuthPassword,
		Jumps: []Jump{
			{Host: "jump", User: "ops", AuthMethod: AuthKey, KeyPath: "first.key", Passphrase: "first-key-secret"},
			{Host: "jump", Port: 22, User: "ops", AuthMethod: AuthKey, KeyPath: "second.key", Passphrase: "second-key-secret"},
		},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	editedJumps := append([]Jump(nil), first.Jumps...)
	for i := range editedJumps {
		editedJumps[i].Passphrase = ""
	}
	first.Name = "renamed"
	first.Jumps = editedJumps
	if _, err := s.Upsert(first); err != nil {
		t.Fatalf("edit: %v", err)
	}
	again, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	got, ok := again.Get(first.ID)
	if !ok || len(got.Jumps) != 2 {
		t.Fatal("jump chain missing after reopen")
	}
	for i, want := range []string{"first-key-secret", "second-key-secret"} {
		if got.Jumps[i].Passphrase != want {
			t.Errorf("jump %d passphrase belongs to another key", i)
		}
	}
	data, err := os.ReadFile(filepath.Join(dir, profilesFile))
	if err != nil {
		t.Fatalf("read profiles: %v", err)
	}
	if strings.Contains(string(data), "first-key-secret") || strings.Contains(string(data), "second-key-secret") {
		t.Fatal("jump passphrase leaked in plaintext")
	}
}

func TestEditKeepsDuplicateJumpSecretsInOrder(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	first, err := s.Upsert(Profile{
		Name: "before", Host: "target", User: "user", AuthMethod: AuthPassword,
		Jumps: []Jump{
			{Host: "jump", User: "ops", AuthMethod: AuthKey, KeyPath: "same.key", Password: "first-password", Passphrase: "first-passphrase"},
			{Host: "jump", Port: 22, User: "ops", AuthMethod: AuthKey, KeyPath: "same.key", Password: "second-password", Passphrase: "second-passphrase"},
		},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	editedJumps := append([]Jump(nil), first.Jumps...)
	for i := range editedJumps {
		editedJumps[i].Password = ""
		editedJumps[i].Passphrase = ""
	}
	first.Jumps = editedJumps
	if _, err := s.Upsert(first); err != nil {
		t.Fatalf("edit: %v", err)
	}
	again, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	got, ok := again.Get(first.ID)
	if !ok || len(got.Jumps) != 2 {
		t.Fatal("duplicate chain missing after reopen")
	}
	if got.Jumps[0].Password != "first-password" || got.Jumps[0].Passphrase != "first-passphrase" {
		t.Error("first duplicate received another occurrence's secrets")
	}
	if got.Jumps[1].Password != "second-password" || got.Jumps[1].Passphrase != "second-passphrase" {
		t.Error("second duplicate lost its own secrets")
	}
}

func TestJumpSecretReuseIdentityAndPersistence(t *testing.T) {
	cases := []struct {
		name        string
		auth        AuthMethod
		edit        func(*Jump)
		wantSecrets bool
	}{
		{"same key", AuthKey, func(j *Jump) {}, true},
		{"same password", AuthPassword, func(j *Jump) {}, true},
		{"default port equals 22", AuthKey, func(j *Jump) { j.Port = 22 }, true},
		{"trimmed key path", AuthKey, func(j *Jump) { j.KeyPath = " old.key " }, true},
		{"changed host", AuthKey, func(j *Jump) { j.Host = "other" }, false},
		{"changed user", AuthKey, func(j *Jump) { j.User = "other" }, false},
		{"changed port", AuthKey, func(j *Jump) { j.Port = 2222 }, false},
		{"changed key", AuthKey, func(j *Jump) { j.KeyPath = "new.key" }, false},
		{"key to password", AuthKey, func(j *Jump) { j.AuthMethod = AuthPassword }, false},
		{"key to agent", AuthKey, func(j *Jump) { j.AuthMethod = AuthAgent }, false},
		{"key to none", AuthKey, func(j *Jump) { j.AuthMethod = AuthNone }, false},
		{"password to key", AuthPassword, func(j *Jump) { j.AuthMethod = AuthKey }, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			dir := t.TempDir()
			s, err := Open(dir)
			if err != nil {
				t.Fatalf("open: %v", err)
			}
			first, err := s.Upsert(Profile{
				Name: "before", Host: "target", User: "user", AuthMethod: AuthPassword,
				Password: "main-secret",
				Jumps: []Jump{{Host: "jump", User: "ops", AuthMethod: c.auth, KeyPath: "old.key",
					Password: "stored-jump-password", Passphrase: "stored-jump-passphrase"}},
			})
			if err != nil {
				t.Fatalf("create: %v", err)
			}
			next := first.Jumps[0]
			next.Password, next.Passphrase = "", ""
			c.edit(&next)
			if _, err := s.Upsert(Profile{
				ID: first.ID, Name: "renamed", Host: "target", User: "user", AuthMethod: AuthPassword,
				Jumps: []Jump{next},
			}); err != nil {
				t.Fatalf("edit: %v", err)
			}
			again, err := Open(dir)
			if err != nil {
				t.Fatalf("reopen: %v", err)
			}
			got, ok := again.Get(first.ID)
			if !ok || len(got.Jumps) != 1 {
				t.Fatal("edited chain missing after reopen")
			}
			wantPassword, wantPassphrase := "", ""
			if c.wantSecrets {
				wantPassword, wantPassphrase = "stored-jump-password", "stored-jump-passphrase"
			}
			if got.Jumps[0].Password != wantPassword || got.Jumps[0].Passphrase != wantPassphrase {
				t.Fatal("jump secrets do not match the edited identity")
			}
			if got.Password != "main-secret" {
				t.Fatal("main password blank-update compatibility changed")
			}
			data, err := os.ReadFile(filepath.Join(dir, profilesFile))
			if err != nil {
				t.Fatalf("read profiles: %v", err)
			}
			for _, secret := range []string{"main-secret", "stored-jump-password", "stored-jump-passphrase"} {
				if strings.Contains(string(data), secret) {
					t.Fatal("profile secret leaked in plaintext")
				}
			}
		})
	}
}

func TestJumpSecretReuseNilAndEmptyChain(t *testing.T) {
	for _, clear := range []bool{false, true} {
		name := "nil keeps chain"
		if clear {
			name = "empty clears chain"
		}
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			s, err := Open(dir)
			if err != nil {
				t.Fatalf("open: %v", err)
			}
			first, err := s.Upsert(Profile{
				Name: "before", Host: "target", User: "user", AuthMethod: AuthPassword,
				Jumps: []Jump{{Host: "jump", User: "ops", AuthMethod: AuthPassword, Password: "jump-secret"}},
			})
			if err != nil {
				t.Fatalf("create: %v", err)
			}
			first.Jumps = nil
			if clear {
				first.Jumps = []Jump{}
			}
			if _, err := s.Upsert(first); err != nil {
				t.Fatalf("edit: %v", err)
			}
			again, err := Open(dir)
			if err != nil {
				t.Fatalf("reopen: %v", err)
			}
			got, ok := again.Get(first.ID)
			if !ok {
				t.Fatal("profile missing after reopen")
			}
			if clear {
				if len(got.Jumps) != 0 {
					t.Fatal("explicit empty chain must clear jumps")
				}
			} else if len(got.Jumps) != 1 || got.Jumps[0].Password != "jump-secret" {
				t.Fatal("omitted chain must keep its secrets")
			}
		})
	}
}

func TestDuplicateJumpMatchesAreConsumedOnce(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	first, err := s.Upsert(Profile{
		Name: "before", Host: "target", User: "user", AuthMethod: AuthPassword,
		Jumps: []Jump{
			{Host: "jump", User: "ops", AuthMethod: AuthPassword, Password: "first-old-password", Passphrase: "first-old-passphrase"},
			{Host: "jump", User: "ops", AuthMethod: AuthPassword, Password: "second-old-password", Passphrase: "second-old-passphrase"},
		},
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	first.Jumps = []Jump{
		{Host: "jump", User: "ops", AuthMethod: AuthPassword, Password: "replacement-password"},
		{Host: "jump", User: "ops", AuthMethod: AuthPassword},
		{Host: "jump", User: "ops", AuthMethod: AuthPassword},
	}
	if _, err := s.Upsert(first); err != nil {
		t.Fatalf("edit: %v", err)
	}
	again, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	got, ok := again.Get(first.ID)
	if !ok || len(got.Jumps) != 3 {
		t.Fatal("edited duplicate chain missing after reopen")
	}
	if got.Jumps[0].Password != "replacement-password" || got.Jumps[0].Passphrase != "first-old-passphrase" {
		t.Error("explicit password must consume its occurrence and keep only the blank passphrase")
	}
	if got.Jumps[1].Password != "second-old-password" || got.Jumps[1].Passphrase != "second-old-passphrase" {
		t.Error("second occurrence must keep the second old secrets")
	}
	if got.Jumps[2].Password != "" || got.Jumps[2].Passphrase != "" {
		t.Error("new duplicate must not reuse an already consumed occurrence")
	}
}
