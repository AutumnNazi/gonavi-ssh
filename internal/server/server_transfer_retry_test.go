package server

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/pkg/sftp"

	"gonavi-ssh/internal/sshclient"
	"gonavi-ssh/internal/transfer"
)

type remoteRetryClients map[string]*sftp.Client

func (c remoteRetryClients) Client(conn *sshclient.Conn) (*sftp.Client, error) {
	return c[conn.ID], nil
}

func newRemoteRetryClient(t *testing.T, handlers sftp.Handlers) *sftp.Client {
	t.Helper()
	serverPipe, clientPipe := net.Pipe()
	server := sftp.NewRequestServer(serverPipe, handlers)
	done := make(chan error, 1)
	go func() { done <- server.Serve() }()
	client, err := sftp.NewClientPipe(clientPipe, clientPipe)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close(); server.Close(); <-done })
	return client
}

func waitRemoteRetry(t *testing.T, manager *transfer.Manager, id string) transfer.Status {
	t.Helper()
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	ticker := time.NewTicker(time.Millisecond)
	defer ticker.Stop()
	for {
		status, ok := manager.Status(id)
		if !ok {
			t.Fatal("task missing")
		}
		if status.State != transfer.Queued && status.State != transfer.Running {
			return status
		}
		select {
		case <-ticker.C:
		case <-timer.C:
			t.Fatal("task did not finish")
			return transfer.Status{}
		}
	}
}

func remoteRetryApp(t *testing.T, sourceHandlers sftp.Handlers) (*App, *sshclient.Conn, *sshclient.Conn, *sftp.Client, *sftp.Client) {
	t.Helper()
	app := newTestApp(t)
	source := &sshclient.Conn{ID: "source", ProfileID: "a", Addr: "fixture-a"}
	target := &sshclient.Conn{ID: "target", ProfileID: "b", Addr: "fixture-b"}
	srcClient := newRemoteRetryClient(t, sourceHandlers)
	dstClient := newRemoteRetryClient(t, sftp.InMemHandler())
	app.transfers = transfer.NewManager(remoteRetryClients{source.ID: srcClient, target.ID: dstClient})
	return app, source, target, srcClient, dstClient
}

func seedRemoteRetry(t *testing.T, client *sftp.Client, path, content string) {
	t.Helper()
	file, err := client.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte(content)); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

func retryUIHandler(app *App, connections map[string]*sshclient.Conn) func(context.Context, json.RawMessage) (any, error) {
	return func(_ context.Context, raw json.RawMessage) (any, error) {
		return app.retryTransfer(raw, func(id string) (*sshclient.Conn, bool) { conn, ok := connections[id]; return conn, ok })
	}
}

func TestRemoteRetryUIHandlerCompletes(t *testing.T) {
	app, source, target, srcClient, dstClient := remoteRetryApp(t, sftp.InMemHandler())
	old, err := app.transfers.StartRemote(source, "/from", target, "/to")
	if err != nil {
		t.Fatal(err)
	}
	if status := waitRemoteRetry(t, app.transfers, old.ID); status.State != transfer.Failed {
		t.Fatalf("want actual source-open failure, got %s", status.State)
	}
	seedRemoteRetry(t, srcClient, "/from", "remote body")
	cfg := app.settings.Get()
	cfg.LocalPathAllowlist = []string{"C:/no-local-path"}
	if err := app.settings.Update(cfg); err != nil {
		t.Fatal(err)
	}
	result, err := invoke(t, retryUIHandler(app, map[string]*sshclient.Conn{source.ID: source, target.ID: target}),
		templateRemoteRetry(old.ID, source.ID))
	if err != nil {
		t.Fatalf("UI retry of serverToServer task: %v", err)
	}
	id := result["taskId"].(string)
	status := waitRemoteRetry(t, app.transfers, id)
	if status.State != transfer.Done {
		t.Fatalf("retry failed: %s %s", status.State, status.Error)
	}
	if status.Direction != transfer.ServerToServer || status.ConnectionID != source.ID || status.PeerConnectionID != target.ID || status.RemotePath != "/from" || status.PeerPath != "/to" || status.LocalPath != "" {
		t.Fatalf("retry changed endpoints: %+v", status)
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
	if string(data) != "remote body" {
		t.Errorf("body=%q", data)
	}
	entries, err := dstClient.ReadDir("/")
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if strings.Contains(entry.Name(), ".copying-") {
			t.Errorf("temporary file retained: %s", entry.Name())
		}
	}
}

func templateRemoteRetry(taskID, connectionID string) string {
	data, _ := json.Marshal(map[string]string{"taskId": taskID, "connectionId": connectionID})
	return string(data)
}
