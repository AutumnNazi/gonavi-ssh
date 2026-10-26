package transfer

import (
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/pkg/sftp"

	"gonavi-ssh/internal/settings"
	"gonavi-ssh/internal/sshclient"
)

type fixtureClient struct{ client *sftp.Client }

func (f fixtureClient) Client(*sshclient.Conn) (*sftp.Client, error) { return f.client, nil }

func newAdmissionFixture(t *testing.T) (*Manager, *sshclient.Conn, *sftp.Client) {
	t.Helper()
	serverPipe, clientPipe := net.Pipe()
	server := sftp.NewRequestServer(serverPipe, sftp.InMemHandler())
	done := make(chan error, 1)
	go func() { done <- server.Serve() }()
	client, err := sftp.NewClientPipe(clientPipe, clientPipe)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close(); server.Close(); <-done })
	return NewManager(fixtureClient{client: client}), &sshclient.Conn{ID: "fixture", ProfileID: "local", Addr: "fixture"}, client
}

func waitAdmissionTask(t *testing.T, task *Task) Status {
	t.Helper()
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		status := task.snapshot()
		if status.State != Queued && status.State != Running {
			return status
		}
		select {
		case <-ticker.C:
		case <-timer.C:
			t.Fatal("fixture task did not finish")
			return Status{}
		}
	}
}

func TestRetryChecksCurrentAllowlist(t *testing.T) {
	for _, dir := range []Direction{Download, Upload} {
		t.Run(string(dir), func(t *testing.T) {
			manager, conn, client := newAdmissionFixture(t)
			root := t.TempDir()
			allowed := filepath.Join(root, "allowed")
			if err := os.Mkdir(allowed, 0o755); err != nil {
				t.Fatal(err)
			}
			localPath := filepath.Join(allowed, "file")
			store, err := settings.Open(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			cfg := store.Get()
			cfg.LocalPathAllowlist = []string{allowed}
			if err := store.Update(cfg); err != nil {
				t.Fatal(err)
			}
			old, err := manager.Start(conn, dir, "/remote", localPath, store.AllowLocalPath)
			if err != nil {
				t.Fatal(err)
			}
			if status := waitAdmissionTask(t, old); status.State != Failed {
				t.Fatalf("want initial fixture failure, got %s", status.State)
			}
			remote, err := client.Create("/remote")
			if err != nil {
				t.Fatal(err)
			}
			if _, err := remote.Write([]byte("remote content")); err != nil {
				t.Fatal(err)
			}
			if err := remote.Close(); err != nil {
				t.Fatal(err)
			}
			if dir == Upload {
				if err := os.WriteFile(localPath, []byte("local content"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			cfg.LocalPathAllowlist = []string{filepath.Join(root, "other")}
			if err := store.Update(cfg); err != nil {
				t.Fatal(err)
			}
			before := len(manager.List())
			id, retryErr := manager.Retry(old.ID, conn, store.AllowLocalPath)
			if retryErr == nil {
				t.Error("retry must reject the revoked local path")
				manager.mu.Lock()
				task := manager.tasks[id]
				manager.mu.Unlock()
				waitAdmissionTask(t, task)
			}
			if len(manager.List()) != before {
				t.Error("rejected retry registered a new task")
			}
			if dir == Download {
				if _, err := os.Stat(localPath); !os.IsNotExist(err) {
					t.Errorf("retry wrote revoked target: %v", err)
				}
			} else {
				file, err := client.Open("/remote")
				if err != nil {
					t.Fatal(err)
				}
				data, err := io.ReadAll(file)
				file.Close()
				if err != nil {
					t.Fatal(err)
				}
				if string(data) != "remote content" {
					t.Errorf("retry uploaded revoked local content: %q", data)
				}
			}
		})
	}
}
