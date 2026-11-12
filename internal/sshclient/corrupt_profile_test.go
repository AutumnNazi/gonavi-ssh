package sshclient

import (
	"gonavi-ssh/internal/profile"
	"strings"
	"testing"
)

func TestCorruptProfileNeverStartsConnection(t *testing.T) {
	m, err := NewManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	p := profile.Profile{ID: "broken", Host: "127.0.0.1", User: "test", AuthMethod: profile.AuthNone, CorruptSecrets: true}
	status := m.OpenBegin(p)
	if status.State != StateFailed || !strings.Contains(status.Error, "credentials") {
		t.Fatalf("corrupt profile started: %+v", status)
	}
	if len(m.Status("")) != 0 {
		t.Fatal("corrupt profile allocated connection state")
	}
	if _, err := m.TestDial(p); err == nil || !strings.Contains(err.Error(), "credentials") {
		t.Fatalf("test dial: %v", err)
	}
}
