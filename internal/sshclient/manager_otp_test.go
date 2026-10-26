package sshclient

import (
	"context"
	"net"
	"strconv"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
	"gonavi-ssh/internal/profile"
)

func TestSlowInteractiveAuthenticationKeepsBudgetAndHandoff(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	config := &ssh.ServerConfig{KeyboardInteractiveCallback: func(_ ssh.ConnMetadata, challenge ssh.KeyboardInteractiveChallenge) (*ssh.Permissions, error) {
		_, err := challenge("fixture", "OTP", []string{"code"}, []bool{false})
		return nil, err
	}}
	config.AddHostKey(testSigner(t))
	done := make(chan struct{})
	go func() {
		defer close(done)
		raw, err := listener.Accept()
		if err != nil {
			return
		}
		defer raw.Close()
		server, channels, requests, err := ssh.NewServerConn(raw, config)
		if err != nil {
			return
		}
		defer server.Close()
		go func() {
			for channel := range channels {
				_ = channel.Reject(ssh.UnknownChannelType, "unsupported")
			}
		}()
		for request := range requests {
			_ = request.Reply(true, nil)
		}
	}()
	host, portText, err := net.SplitHostPort(listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	port, err := strconv.Atoi(portText)
	if err != nil {
		t.Fatal(err)
	}
	manager, err := NewManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	client, err := manager.dialHop(ctx, dialTarget{host: host, port: port, stage: "main", creds: creds{User: "fixture", AuthMethod: profile.AuthPassword}}, func(string) ssh.KeyboardInteractiveChallenge {
		return func(_, _ string, _ []string, _ []bool) ([]string, error) {
			time.Sleep(dialTimeout + 200*time.Millisecond)
			return []string{"123456"}, nil
		}
	})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	cancel()
	conn := &Conn{client: client, done: make(chan struct{})}
	if !manager.keepaliveProbe(conn) {
		t.Fatal("successful handoff was closed by pending context cancellation")
	}
	_ = client.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("OTP fixture did not stop")
	}
	if interactiveTimeout != 120*time.Second {
		t.Fatal("interactive budget changed")
	}
}
