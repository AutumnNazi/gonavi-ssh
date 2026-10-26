package sshclient

import (
	"crypto/ed25519"
	"crypto/rand"
	"net"
	"strings"
	"testing"

	"golang.org/x/crypto/ssh"
)

func testKey(t *testing.T) ssh.PublicKey {
	t.Helper()
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	key, err := ssh.NewPublicKey(pub)
	if err != nil {
		t.Fatalf("new public key: %v", err)
	}
	return key
}

func fakeAddr(host string) net.Addr {
	return &net.TCPAddr{IP: net.ParseIP(host), Port: 22}
}

// TOFU：首次接受并记录；同 key 再次接受；不同 key 拒绝并报指纹差异。
func TestTOFUAcceptThenRejectChange(t *testing.T) {
	kh, err := loadKnownHosts(t.TempDir())
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	cb := kh.callback()
	key1 := testKey(t)
	addr := fakeAddr("192.0.2.10")

	if err := cb("", addr, key1); err != nil {
		t.Fatalf("first use should be accepted: %v", err)
	}
	if err := cb("", addr, key1); err != nil {
		t.Fatalf("same key should be accepted: %v", err)
	}

	key2 := testKey(t)
	err = cb("", addr, key2)
	if err == nil {
		t.Fatal("changed key must be rejected")
	}
	if !strings.Contains(err.Error(), "HOST KEY CHANGED") {
		t.Fatalf("error should explain the change: %v", err)
	}
	if !strings.Contains(err.Error(), "SHA256:") {
		t.Fatalf("error should include fingerprints: %v", err)
	}
}

// 不同主机互不影响。
func TestTOFUSeparateHosts(t *testing.T) {
	kh, _ := loadKnownHosts(t.TempDir())
	cb := kh.callback()
	keyA := testKey(t)
	if err := cb("", fakeAddr("192.0.2.10"), keyA); err != nil {
		t.Fatalf("host1 first: %v", err)
	}
	keyB := testKey(t)
	if err := cb("", fakeAddr("192.0.2.11"), keyB); err != nil {
		t.Fatalf("host2 first: %v", err)
	}
}

// 无端口地址归一化为 host:22，与带 22 端口的记录命中同一条。
func TestNormalizeAddr(t *testing.T) {
	if got := normalizeAddr("192.0.2.10"); got != "192.0.2.10:22" {
		t.Fatalf("got %q", got)
	}
	if got := normalizeAddr("192.0.2.10:22"); got != "192.0.2.10:22" {
		t.Fatalf("got %q", got)
	}
}
