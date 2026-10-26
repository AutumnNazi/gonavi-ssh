package server

import (
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	goplugin "github.com/Syngnat/GoNavi/sdk/go"
	"github.com/pkg/sftp"

	"gonavi-ssh/internal/sshclient"
	"gonavi-ssh/internal/transfer"
)

type blockedRemoteRead struct {
	sftp.FileReader
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (b *blockedRemoteRead) Fileread(r *sftp.Request) (io.ReaderAt, error) {
	b.once.Do(func() { close(b.started) })
	<-b.release
	return b.FileReader.Fileread(r)
}

func TestRemoteRetryCancelledHandler(t *testing.T) {
	handlers := sftp.InMemHandler()
	block := &blockedRemoteRead{FileReader: handlers.FileGet, started: make(chan struct{}), release: make(chan struct{})}
	handlers.FileGet = block
	app, source, target, srcClient, dstClient := remoteRetryApp(t, handlers)
	seedRemoteRetry(t, srcClient, "/from", "cancelled body")
	old, err := app.transfers.StartRemote(source, "/from", target, "/to")
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-block.started:
	case <-time.After(3 * time.Second):
		close(block.release)
		t.Fatal("source was not opened")
	}
	if err := app.transfers.Cancel(old.ID); err != nil {
		close(block.release)
		t.Fatal(err)
	}
	close(block.release)
	if status := waitRemoteRetry(t, app.transfers, old.ID); status.State != transfer.Cancelled {
		t.Fatalf("cancelled status=%s %s", status.State, status.Error)
	}
	res, err := invoke(t, retryUIHandler(app, map[string]*sshclient.Conn{source.ID: source, target.ID: target}), templateRemoteRetry(old.ID, source.ID))
	if err != nil {
		t.Fatal(err)
	}
	if status := waitRemoteRetry(t, app.transfers, res["taskId"].(string)); status.State != transfer.Done {
		t.Fatalf("retry status=%s %s", status.State, status.Error)
	}
	file, err := dstClient.Open("/to")
	if err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(file)
	file.Close()
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "cancelled body" {
		t.Errorf("body=%q", data)
	}
}

func TestRemoteRetryRejectsInvalidRoute(t *testing.T) {
	for _, scenario := range []string{"unknown", "done", "missing target", "missing source", "same endpoints", "changed source", "changed target"} {
		t.Run(scenario, func(t *testing.T) {
			app, source, target, srcClient, _ := remoteRetryApp(t, sftp.InMemHandler())
			if scenario == "done" {
				seedRemoteRetry(t, srcClient, "/from", "done")
			}
			old, err := app.transfers.StartRemote(source, "/from", target, "/to")
			if err != nil {
				t.Fatal(err)
			}
			waitRemoteRetry(t, app.transfers, old.ID)
			connections := map[string]*sshclient.Conn{source.ID: source, target.ID: target}
			taskID, sourceID := old.ID, source.ID
			wantCode, wantText := errSession, ""
			switch scenario {
			case "unknown":
				taskID = "unknown"
				wantCode = errNotFound
				wantText = "task not found"
			case "done":
				wantText = "only failed or cancelled"
			case "missing target":
				delete(connections, target.ID)
				wantCode = errNotFound
				wantText = "target connection"
			case "missing source":
				delete(connections, source.ID)
				wantCode = errNotFound
				wantText = "connection not found"
			case "same endpoints":
				connections[target.ID] = source
				wantText = "target connection does not match"
			case "changed source":
				sourceID = "replacement"
				connections[sourceID] = &sshclient.Conn{ID: sourceID}
				wantText = "source connection does not match"
			case "changed target":
				connections[target.ID] = &sshclient.Conn{ID: "replacement"}
				wantText = "target connection does not match"
			}
			before := len(app.transfers.List())
			_, err = invoke(t, retryUIHandler(app, connections), templateRemoteRetry(taskID, sourceID))
			pluginErr, ok := err.(*goplugin.Error)
			if !ok || pluginErr.Code != wantCode || !strings.Contains(err.Error(), wantText) {
				t.Fatalf("route error=%v want code=%d text=%s", err, wantCode, wantText)
			}
			if len(app.transfers.List()) != before {
				t.Fatal("invalid route registered task")
			}
		})
	}
}

func TestLocalRetryHandlerKeepsAdmission(t *testing.T) {
	for _, dir := range []transfer.Direction{transfer.Upload, transfer.Download} {
		t.Run(string(dir), func(t *testing.T) {
			app, source, _, client, _ := remoteRetryApp(t, sftp.InMemHandler())
			localPath := filepath.Join(t.TempDir(), "file")
			old, err := app.transfers.Start(source, dir, "/remote", localPath, app.settings.AllowLocalPath)
			if err != nil {
				t.Fatal(err)
			}
			if status := waitRemoteRetry(t, app.transfers, old.ID); status.State != transfer.Failed {
				t.Fatalf("want initial failure: %s", status.State)
			}
			seedRemoteRetry(t, client, "/remote", "remote")
			if dir == transfer.Upload {
				if err := os.WriteFile(localPath, []byte("local"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			cfg := app.settings.Get()
			cfg.LocalPathAllowlist = []string{filepath.Join(t.TempDir(), "other")}
			if err := app.settings.Update(cfg); err != nil {
				t.Fatal(err)
			}
			before := len(app.transfers.List())
			_, err = invoke(t, retryUIHandler(app, map[string]*sshclient.Conn{source.ID: source}), templateRemoteRetry(old.ID, source.ID))
			if err == nil || !strings.Contains(err.Error(), "localPathAllowlist") {
				t.Fatalf("revoked path error=%v", err)
			}
			if len(app.transfers.List()) != before {
				t.Fatal("rejected local retry registered task")
			}
			cfg.LocalPathAllowlist = []string{filepath.Dir(localPath)}
			if err := app.settings.Update(cfg); err != nil {
				t.Fatal(err)
			}
			res, err := invoke(t, retryUIHandler(app, map[string]*sshclient.Conn{source.ID: source}), templateRemoteRetry(old.ID, source.ID))
			if err != nil {
				t.Fatal(err)
			}
			if status := waitRemoteRetry(t, app.transfers, res["taskId"].(string)); status.State != transfer.Done {
				t.Fatalf("local retry=%s %s", status.State, status.Error)
			}
		})
	}
}
