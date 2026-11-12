package profile

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestCorruptSecretsSurviveUnrelatedSave(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	p, err := s.Upsert(Profile{Name: "original", Host: "host", User: "u", AuthMethod: AuthPassword,
		Password: "password", Passphrase: "passphrase", SudoPassword: "sudo",
		Jumps: []Jump{{Host: "jump", User: "u", AuthMethod: AuthPassword, Password: "jump-password"}}})
	if err != nil {
		t.Fatal(err)
	}
	key, err := os.ReadFile(filepath.Join(dir, keyFile))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(dir, keyFile)); err != nil {
		t.Fatal(err)
	}
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.Upsert(Profile{Name: "other", Host: "other", User: "u", AuthMethod: AuthNone}); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, keyFile), key, 0o600); err != nil {
		t.Fatal(err)
	}
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := s.Get(p.ID)
	if got.CorruptSecrets || got.Password != p.Password || got.Passphrase != p.Passphrase || got.SudoPassword != p.SudoPassword || len(got.Jumps) != 1 || got.Jumps[0].Password != "jump-password" {
		t.Fatal("unrelated save destroyed recoverable encrypted credentials")
	}
}

func TestCorruptJumpIsMarkedAndSurvivesEdit(t *testing.T) {
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	p, err := s.Upsert(Profile{Name: "jumps", Host: "target", User: "u", AuthMethod: AuthAgent,
		Jumps: []Jump{{Host: "jump", User: "u", AuthMethod: AuthAgent}}})
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(dir, profilesFile))
	if err != nil {
		t.Fatal(err)
	}
	var disk storedFile
	if err := json.Unmarshal(data, &disk); err != nil {
		t.Fatal(err)
	}
	disk.Profiles[0].JumpsSealed = "invalid-ciphertext"
	data, _ = json.Marshal(disk)
	if err := os.WriteFile(filepath.Join(dir, profilesFile), data, 0o600); err != nil {
		t.Fatal(err)
	}
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := s.Get(p.ID)
	if !got.CorruptSecrets {
		t.Fatal("corrupt jump silently became direct connection")
	}
	got.Name = "renamed"
	got, err = s.Upsert(got)
	if err != nil {
		t.Fatal(err)
	}
	if !got.CorruptSecrets {
		t.Fatal("edit cleared corruption marker")
	}
	data, _ = os.ReadFile(filepath.Join(dir, profilesFile))
	if err := json.Unmarshal(data, &disk); err != nil {
		t.Fatal(err)
	}
	if disk.Profiles[0].JumpsSealed != "invalid-ciphertext" {
		t.Fatal("edit discarded damaged jump ciphertext")
	}
	got.Jumps = []Jump{}
	got, err = s.Upsert(got)
	if err != nil {
		t.Fatal(err)
	}
	if got.CorruptSecrets {
		t.Fatal("explicitly clearing damaged jumps must clear marker")
	}
}

func TestFailedPersistenceDoesNotChangeLiveProfiles(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p, err := s.Upsert(Profile{Name: "before", Host: "host", User: "u", AuthMethod: AuthNone})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(s.dir, profilesFile+".tmp"), 0o700); err != nil {
		t.Fatal(err)
	}
	p.Name = "after"
	if _, err := s.Upsert(p); err == nil {
		t.Fatal("expected persistence failure")
	}
	if got, _ := s.Get(p.ID); got.Name != "before" {
		t.Fatal("failed update changed live profile")
	}
	if err := s.Delete(p.ID); err == nil {
		t.Fatal("expected persistence failure")
	}
	if _, ok := s.Get(p.ID); !ok {
		t.Fatal("failed delete changed live profiles")
	}
	if _, err := s.Upsert(Profile{Name: "new", Host: "host", User: "u", AuthMethod: AuthNone}); err == nil {
		t.Fatal("expected persistence failure")
	}
	if len(s.List()) != 1 {
		t.Fatal("failed insert changed live profiles")
	}
}

func TestReturnedProfilesDoNotMutateStoredJumpChain(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p, err := s.Upsert(Profile{Name: "jump", Host: "target", User: "u", AuthMethod: AuthAgent, Jumps: []Jump{{Host: "jump", User: "u", AuthMethod: AuthAgent}}})
	if err != nil {
		t.Fatal(err)
	}
	p.Jumps[0].Host = "changed"
	got, _ := s.Get(p.ID)
	if got.Jumps[0].Host != "jump" {
		t.Fatal("Upsert result aliases store")
	}
	got.Jumps[0].Host = "changed"
	list := s.List()
	if list[0].Jumps[0].Host != "jump" {
		t.Fatal("Get result aliases store")
	}
	list[0].Jumps[0].Host = "changed"
	got, _ = s.Get(p.ID)
	if got.Jumps[0].Host != "jump" {
		t.Fatal("List result aliases store")
	}
}
