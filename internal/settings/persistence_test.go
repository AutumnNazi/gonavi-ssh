package settings

import (
	"os"
	"testing"
)

func TestFailedUpdateKeepsEffectiveSettings(t *testing.T) {
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(s.path+".tmp", 0o700); err != nil {
		t.Fatal(err)
	}
	next := s.Get()
	next.ReadOnly = !next.ReadOnly
	next.LocalPathAllowlist = []string{"unreachable"}
	if err := s.Update(next); err == nil {
		t.Fatal("expected persistence failure")
	}
	if got := s.Get(); got.ReadOnly == next.ReadOnly || len(got.LocalPathAllowlist) != 0 {
		t.Fatal("failed update changed effective policy")
	}
}
