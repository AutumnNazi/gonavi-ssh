package agentcmd

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"

	"gonavi-ssh/internal/profile"
	"gonavi-ssh/internal/sshclient"
	"gonavi-ssh/internal/terminal"
)

// lifecyclePeer speaks real SSH but deliberately withholds a selected reply.
// No external server, shell or remote command is involved in these tests.
func lifecyclePeer(t *testing.T, hold string, output string) (*sshclient.Conn, <-chan struct{}) {
	conn, reached, _ := managedLifecyclePeer(t, hold, output)
	return conn, reached
}

func managedLifecyclePeer(t *testing.T, hold string, output string) (*sshclient.Conn, <-chan struct{}, *sshclient.Manager) {
	t.Helper()
	_, key, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		t.Fatal(err)
	}
	cfg := &ssh.ServerConfig{NoClientAuth: true}
	cfg.AddHostKey(signer)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	reached := make(chan struct{}, 100)
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		raw, err := listener.Accept()
		if err != nil {
			return
		}
		defer raw.Close()
		server, channels, requests, err := ssh.NewServerConn(raw, cfg)
		if err != nil {
			return
		}
		defer server.Close()
		go ssh.DiscardRequests(requests)
		for incoming := range channels {
			if hold == "open" {
				reached <- struct{}{}
				continue
			}
			channel, requests, err := incoming.Accept()
			if err != nil {
				return
			}
			go func() {
				defer channel.Close()
				for req := range requests {
					if req.Type == hold {
						reached <- struct{}{}
						continue
					}
					_ = req.Reply(true, nil)
					if req.Type == "exec" {
						if hold == "running" {
							reached <- struct{}{}
							continue
						}
						_, _ = io.WriteString(channel, output)
						_, _ = channel.SendRequest("exit-status", false, ssh.Marshal(struct{ Code uint32 }{0}))
						return
					}
				}
			}()
		}
	}()
	manager, err := sshclient.NewManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		manager.CloseAll()
		_ = listener.Close()
		select {
		case <-finished:
		case <-time.After(2 * time.Second):
			t.Error("SSH fixture leaked")
		}
	})
	port := listener.Addr().(*net.TCPAddr).Port
	status := manager.OpenBegin(profile.Profile{ID: "fixture", Host: "127.0.0.1", Port: port, User: "fixture", AuthMethod: profile.AuthNone})
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if conn, ok := manager.Get(status.ConnectionID); ok {
			return conn, reached, manager
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("SSH fixture did not connect")
	return nil, nil, nil
}

func TestSetupTimeoutRetiresConnectionAndCleansResources(t *testing.T) {
	conn, _, manager := managedLifecyclePeer(t, "open", "")
	cleaned := make(chan string, 1)
	manager.OnDead(func(id string) {
		// The callback must be outside the manager lock: resource cleanup may
		// query the remaining connections before releasing its own cache.
		if statuses := manager.Status(id); len(statuses) != 0 {
			t.Errorf("retired connection remains visible: %+v", statuses)
		}
		cleaned <- id
	})
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if _, err := conn.OpenSession(ctx, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("setup timeout: %v", err)
	}
	select {
	case id := <-cleaned:
		if id != conn.ID {
			t.Fatalf("cleaned wrong connection: %s", id)
		}
	case <-time.After(time.Second):
		t.Fatalf("setup timeout skipped cleanup: %+v", manager.Status(""))
	}
}

func TestCancellationFallbackRetiresConnectionAndCleansResources(t *testing.T) {
	conn, _, manager := managedLifecyclePeer(t, "running", "")
	cleaned := make(chan string, 1)
	manager.OnDead(func(id string) { cleaned <- id })
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	session, err := conn.OpenSession(ctx, func(session *ssh.Session) error { return session.Start("fixture") })
	if err != nil {
		t.Fatal(err)
	}
	// Model a Wait that does not complete during the channel-close grace.
	// This directly exercises the cancellation fallback without a flaky TCP
	// blackhole or a socket-buffer-size dependency.
	cancelSession(conn, session, make(chan error))
	select {
	case id := <-cleaned:
		if id != conn.ID || len(manager.Status("")) != 0 {
			t.Fatalf("retirement did not clear indexes: id=%s statuses=%+v", id, manager.Status(""))
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("fallback skipped cleanup: %+v", manager.Status(""))
	}
}

func TestExecDeadlineIncludesChannelCreation(t *testing.T) {
	for _, sudoStdin := range []bool{false, true} {
		t.Run(map[bool]string{false: "exec", true: "stdin"}[sudoStdin], func(t *testing.T) {
			conn, reached := lifecyclePeer(t, "open", "")
			done := make(chan ExecResult, 1)
			go func() {
				m := NewManager(nil)
				var res ExecResult
				if sudoStdin {
					res, _ = m.execWithStdin(context.Background(), conn, "fixture", "secret\n", 100)
				} else {
					res, _ = m.Exec(context.Background(), conn, "fixture", 100)
				}
				done <- res
			}()
			select {
			case <-reached:
			case <-time.After(time.Second):
				t.Fatal("channel was never requested")
			}
			select {
			case res := <-done:
				if !res.TimedOut || conn.Alive() {
					t.Fatalf("result=%+v alive=%v", res, conn.Alive())
				}
			case <-time.After(time.Second):
				t.Fatal("channel creation ignored deadline")
			}
		})
	}
}

func TestExecDeadlineIncludesExecAcknowledgement(t *testing.T) {
	conn, reached := lifecyclePeer(t, "exec", "")
	done := make(chan ExecResult, 1)
	go func() {
		res, _ := NewManager(nil).Exec(context.Background(), conn, "fixture", 100)
		done <- res
	}()
	select {
	case <-reached:
	case <-time.After(time.Second):
		t.Fatal("exec was never requested")
	}
	select {
	case res := <-done:
		if !res.TimedOut || conn.Alive() {
			t.Fatalf("result=%+v alive=%v", res, conn.Alive())
		}
	case <-time.After(time.Second):
		t.Fatal("exec acknowledgement ignored deadline")
	}
}

func TestCancelledCallDoesNotOpenOrRetireConnection(t *testing.T) {
	conn, reached := lifecyclePeer(t, "open", "")
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	res, err := NewManager(nil).Exec(ctx, conn, "fixture", 100)
	if err != nil || !res.TimedOut || !conn.Alive() {
		t.Fatalf("result=%+v error=%v alive=%v", res, err, conn.Alive())
	}
	select {
	case <-reached:
		t.Fatal("cancelled call opened a channel")
	default:
	}
}

func TestCommandTimeoutKeepsResponsiveConnection(t *testing.T) {
	conn, _ := lifecyclePeer(t, "running", "")
	res, err := NewManager(nil).Exec(context.Background(), conn, "fixture", 100)
	if err != nil || !res.TimedOut {
		t.Fatalf("result=%+v error=%v", res, err)
	}
	// Wait past the cancellation grace: a responsive peer acknowledges close,
	// so cancelling one command must leave other terminals on this connection.
	time.Sleep(600 * time.Millisecond)
	if !conn.Alive() {
		t.Fatal("command timeout retired a responsive connection")
	}
}

func TestTerminalSetupDeadlineIncludesPtyAndShell(t *testing.T) {
	for _, stage := range []string{"open", "pty-req", "shell"} {
		t.Run(stage, func(t *testing.T) {
			conn, reached := lifecyclePeer(t, stage, "")
			ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
			defer cancel()
			manager := terminal.NewManager(10)
			defer manager.CloseAll()
			done := make(chan error, 1)
			go func() { _, err := manager.Open(ctx, conn, 80, 24); done <- err }()
			select {
			case <-reached:
			case <-time.After(time.Second):
				t.Fatal("setup stage not reached")
			}
			select {
			case err := <-done:
				if !errors.Is(err, context.DeadlineExceeded) {
					t.Fatalf("error=%v", err)
				}
				if len(manager.List("")) != 0 {
					t.Fatal("timed-out terminal was registered")
				}
			case <-time.After(time.Second):
				t.Fatal("terminal setup ignored deadline")
			}
		})
	}
}

func TestTerminalHistoryPolicyAppliesToNewAndLiveSessions(t *testing.T) {
	conn, _ := lifecyclePeer(t, "", "")
	manager := terminal.NewManager(10)
	defer manager.CloseAll()
	manager.SetHistory(false, 10)
	session, err := manager.Open(context.Background(), conn, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := session.Write([]byte("hidden input\r")); err != nil {
		t.Fatal(err)
	}
	if got := session.History(0); len(got) != 0 {
		t.Fatalf("new disabled session recorded %q", got)
	}
	manager.SetHistory(true, 10)
	if _, err := session.Write([]byte("visible command\r")); err != nil {
		t.Fatal(err)
	}
	if got := session.History(0); len(got) != 1 || got[0] != "visible command" {
		t.Fatalf("history=%q", got)
	}
	manager.SetHistory(false, 10)
	if got := session.History(0); len(got) != 0 {
		t.Fatalf("disabled session retained %q", got)
	}
}

func TestExecMultiSharesOutputBudget(t *testing.T) {
	for _, count := range []int{2, 10} {
		conn, _ := lifecyclePeer(t, "", strings.Repeat("x", maxOutputBytes+1))
		conns := make([]*sshclient.Conn, count)
		for i := range conns {
			conns[i] = conn
		}
		results := NewManager(nil).ExecMulti(context.Background(), conns, "fixture", 2000)
		frame, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": 1, "result": map[string]any{"results": results}})
		if err != nil {
			t.Fatal(err)
		}
		if len(frame) >= 1<<20 {
			t.Fatalf("%d hosts exceeded frame budget: %d", count, len(frame))
		}
		for _, result := range results {
			decoded, err := base64.StdEncoding.DecodeString(result.OutputBase64)
			if err != nil || len(decoded) != maxOutputBytes/count || !result.Truncated || !result.HasExit || result.ExitCode != 0 || result.Error != "" {
				t.Fatalf("unexpected result: bytes=%d truncated=%v exit=%v error=%s decode=%v", len(decoded), result.Truncated, result.HasExit, result.Error, err)
			}
		}
	}
}

func TestBackgroundRunningLimitAndCancellationDuringSetup(t *testing.T) {
	conn, reached := lifecyclePeer(t, "open", "")
	manager := NewManager(nil)
	ids := make([]string, 0, maxBgTasks)
	defer func() {
		for _, id := range ids {
			_ = manager.TaskCancel(id)
		}
	}()
	for i := 0; i < maxBgTasks; i++ {
		id, err := manager.RunBg(conn, "fixture")
		if err != nil {
			t.Fatal(err)
		}
		ids = append(ids, id)
	}
	if _, err := manager.RunBg(conn, "fixture"); err == nil {
		t.Fatal("accepted a 51st running task")
	}
	select {
	case <-reached:
	case <-time.After(time.Second):
		t.Fatal("channel was not requested")
	}
	if err := manager.TaskCancel(ids[0]); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		status, err := manager.TaskStatus(ids[0], 0)
		if err != nil {
			t.Fatal(err)
		}
		if status["state"] == "cancelled" {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("cancelling pending channel setup did not finish the task")
}

func TestBackgroundCompletedTasksAreEvicted(t *testing.T) {
	conn, _ := lifecyclePeer(t, "", "done")
	manager := NewManager(nil)
	for i := 0; i < maxBgTasks; i++ {
		id := string(rune('a' + i))
		manager.tasks[id] = &BgTask{ID: id, CreatedAt: time.Now().Add(-time.Hour), state: "done", output: &taskBuffer{}}
	}
	id, err := manager.RunBg(conn, "fixture")
	if err != nil {
		t.Fatal(err)
	}
	defer manager.TaskCancel(id)
	manager.mu.Lock()
	count := len(manager.tasks)
	manager.mu.Unlock()
	if count != maxBgTasks {
		t.Fatalf("retained %d tasks", count)
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		status, err := manager.TaskStatus(id, 0)
		if err != nil {
			t.Fatal(err)
		}
		if status["state"] == "done" {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("new background task did not complete")
}
