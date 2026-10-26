package sshclient

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"gonavi-ssh/internal/profile"
)

// The outer SSH peer stops delivering packets after accepting the tunnel,
// including channel-close acknowledgements. Cleanup alone releases the gate.
type gatedPeer struct {
	net.Conn
	holding atomic.Bool
	blocked chan struct{}
	release chan struct{}
	once    sync.Once
}

func (c *gatedPeer) Read(p []byte) (int, error) {
	n, err := c.Conn.Read(p)
	if c.holding.Load() {
		c.once.Do(func() { close(c.blocked) })
		<-c.release
	}
	return n, err
}

func testSigner(t *testing.T) ssh.Signer {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		t.Fatal(err)
	}
	return signer
}

func blackholeJump(t *testing.T) (*ssh.Client, <-chan struct{}) {
	t.Helper()
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	config := &ssh.ServerConfig{NoClientAuth: true}
	config.AddHostKey(testSigner(t))
	blocked := make(chan struct{})
	release := make(chan struct{})
	done := make(chan struct{})
	go func() {
		defer close(done)
		raw, err := listener.Accept()
		if err != nil {
			return
		}
		defer raw.Close()
		peer := &gatedPeer{Conn: raw, blocked: blocked, release: release}
		server, channels, requests, err := ssh.NewServerConn(peer, config)
		if err != nil {
			return
		}
		defer server.Close()
		go ssh.DiscardRequests(requests)
		for incoming := range channels {
			if incoming.ChannelType() != "direct-tcpip" {
				_ = incoming.Reject(ssh.UnknownChannelType, "unsupported")
				continue
			}
			peer.holding.Store(true)
			if _, _, err := incoming.Accept(); err != nil {
				return
			}
			_ = server.Wait()
			return
		}
	}()
	client, err := ssh.Dial("tcp", listener.Addr().String(), &ssh.ClientConfig{
		User: "fixture", HostKeyCallback: ssh.InsecureIgnoreHostKey(), Timeout: time.Second,
	})
	if err != nil {
		close(release)
		_ = listener.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = client.Close()
		close(release)
		_ = listener.Close()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("blackhole fixture did not stop")
		}
	})
	return client, blocked
}

type checkingContext struct {
	context.Context
	checked chan struct{}
	release chan struct{}
	once    sync.Once
}

func (c *checkingContext) Err() error {
	err := c.Context.Err()
	c.once.Do(func() {
		close(c.checked)
		<-c.release
	})
	return err
}

func TestDialCompletionRacesCleanup(t *testing.T) {
	for _, operation := range []string{"cancel", "close", "closeAll"} {
		t.Run(operation, func(t *testing.T) {
			manager, err := NewManager(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			client, _ := blackholeJump(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			gate := &checkingContext{Context: ctx, checked: make(chan struct{}), release: make(chan struct{})}
			pend := &Pending{ID: "old", ProfileID: "profile", ctx: gate, cancel: cancel, done: make(chan struct{})}
			manager.pending[pend.ID] = pend
			manager.byProfilePending[pend.ProfileID] = pend
			t.Cleanup(manager.CloseAll)
			go func() {
				defer close(pend.done)
				manager.finishDial(pend, profile.Profile{ID: pend.ProfileID}, client, nil, nil)
			}()
			select {
			case <-gate.checked:
			case <-time.After(time.Second):
				t.Fatal("registration did not check cancellation")
			}
			outsideLock := manager.mu.TryLock()
			if outsideLock {
				manager.mu.Unlock()
			}
			cleaned := make(chan struct{})
			go func() {
				switch operation {
				case "cancel":
					manager.CancelPending(pend.ID)
				case "close":
					manager.CloseByID(pend.ID)
				case "closeAll":
					manager.CloseAll()
				}
				close(cleaned)
			}()
			if outsideLock {
				select {
				case <-ctx.Done():
				case <-time.After(time.Second):
					close(gate.release)
					t.Fatal("cleanup did not cancel pending registration")
				}
			}
			close(gate.release)
			select {
			case <-pend.done:
			case <-time.After(time.Second):
				t.Fatal("registration did not finish")
			}
			select {
			case <-cleaned:
			case <-time.After(time.Second):
				t.Fatal("cleanup did not finish")
			}
			if got := manager.Status(pend.ID); len(got) != 0 {
				t.Fatalf("cancelled completion resurrected connection: %+v", got)
			}
		})
	}
}

func TestOldDialDoesNotRemoveReplacementPending(t *testing.T) {
	manager, err := NewManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	old := &Pending{ID: "old", ProfileID: "profile", ctx: ctx, cancel: cancel}
	nextCtx, nextCancel := context.WithCancel(context.Background())
	defer nextCancel()
	next := &Pending{ID: "new", ProfileID: "profile", ctx: nextCtx, cancel: nextCancel}
	manager.pending[old.ID] = old
	manager.pending[next.ID] = next
	manager.byProfilePending[old.ProfileID] = next
	manager.finishDial(old, profile.Profile{ID: old.ProfileID}, nil, nil, errors.New("cancelled dial"))
	if manager.byProfilePending[next.ProfileID] != next {
		t.Fatal("old completion removed replacement pending index")
	}
}

func TestTunnelCancelWithoutCloseAck(t *testing.T) {
	testTunnelStops(t, true)
}

func TestTunnelTimeoutWithoutCloseAck(t *testing.T) {
	testTunnelStops(t, false)
}

func testTunnelStops(t *testing.T, cancelHandshake bool) {
	t.Helper()
	manager, err := NewManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	jump, blocked := blackholeJump(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan error, 1)
	go func() {
		client, err := manager.dialHop(ctx, dialTarget{
			host: "fixture.invalid", port: 22, stage: "main", via: jump,
			creds: creds{User: "fixture", AuthMethod: profile.AuthNone},
		}, nil)
		if client != nil {
			_ = client.Close()
		}
		result <- err
	}()
	select {
	case <-blocked:
	case <-time.After(2 * time.Second):
		t.Fatal("tunnel did not enter blackhole")
	}
	wait := dialTimeout + time.Second
	wantErr := context.DeadlineExceeded
	if cancelHandshake {
		cancel()
		wait = time.Second
		wantErr = context.Canceled
	}
	select {
	case err := <-result:
		if !errors.Is(err, wantErr) {
			t.Fatalf("handshake error=%v want %v", err, wantErr)
		}
	case <-time.After(wait):
		_ = jump.Close()
		<-result
		t.Fatal("handshake still waits for a channel-close acknowledgement")
	}
	upstreamDone := make(chan struct{})
	go func() { _ = jump.Wait(); close(upstreamDone) }()
	select {
	case <-upstreamDone:
	case <-time.After(time.Second):
		t.Fatal("handshake left upstream transport running")
	}
}
