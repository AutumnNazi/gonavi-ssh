package settings

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAllowLocalPathIndependentSidecars(t *testing.T) {
	root := t.TempDir()
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	cfg := store.Get()
	cfg.LocalPathAllowlist = []string{root}
	if err := store.Update(cfg); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{".part", ".part.meta"} {
		if !store.AllowLocalPath(filepath.Join(root, "newfile") + suffix) {
			t.Errorf("ordinary new sidecar %s must be allowed", suffix)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "newfile"), []byte("original"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, suffix := range []string{".part", ".part.meta"} {
		if !store.AllowLocalPath(filepath.Join(root, "newfile") + suffix) {
			t.Errorf("sibling of existing leaf %s must be allowed", suffix)
		}
	}
}
