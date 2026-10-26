package sshclient

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
	"gonavi-ssh/internal/profile"
)

type closeTrackingConn struct {
	ssh.Conn
	closed atomic.Bool
}

func (c *closeTrackingConn) Close() error {
	c.closed.Store(true)
	return c.Conn.Close()
}

func TestTunnelCancelClosesOwnedRootTransport(t *testing.T) {
	manager, err := NewManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	rootClient, _ := blackholeJump(t)
	root := &closeTrackingConn{Conn: rootClient.Conn}
	jump, blocked := blackholeJump(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := manager.dialHop(ctx, dialTarget{host: "fixture.invalid", port: 22, via: jump, root: &ssh.Client{Conn: root}, creds: creds{AuthMethod: profile.AuthNone}}, nil)
		done <- err
	}()
	select {
	case <-blocked:
	case <-time.After(time.Second):
		t.Fatal("tunnel did not start")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("root cancellation did not finish")
	}
	if !root.closed.Load() {
		t.Fatal("owned root transport was not closed")
	}
}

// Root transport shutdown releases a nested SSH handshake without remote ACKs.
func TestOwnedRootCloseTerminatesNestedHandshake(t *testing.T) {
	root, blocked := blackholeJump(t)
	channel, err := root.Dial("tcp", "fixture.invalid:22")
	if err != nil {
		t.Fatal(err)
	}
	defer channel.Close()
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _, _, _ = ssh.NewClientConn(channel, "fixture.invalid:22", &ssh.ClientConfig{HostKeyCallback: ssh.InsecureIgnoreHostKey()})
	}()
	select {
	case <-blocked:
	case <-time.After(time.Second):
		t.Fatal("nested handshake did not enter blackhole")
	}
	_ = root.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("root close left nested handshake alive")
	}
}
