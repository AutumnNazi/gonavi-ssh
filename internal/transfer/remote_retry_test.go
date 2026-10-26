package transfer

import (
	"strings"
	"testing"

	"gonavi-ssh/internal/sshclient"
)

func TestRemoteRetryRejectsMissingPeer(t *testing.T) {
	manager, source, _ := newAdmissionFixture(t)
	target := &sshclient.Conn{ID: "target"}
	old, err := manager.StartRemote(source, "/missing", target, "/to")
	if err != nil {
		t.Fatal(err)
	}
	if status := waitAdmissionTask(t, old); status.State != Failed {
		t.Fatalf("want failed source-open task: %s", status.State)
	}
	before := len(manager.List())
	for _, peers := range [][]*sshclient.Conn{nil, {nil}, {source}, {target, target}} {
		if _, err := manager.Retry(old.ID, source, nil, peers...); err == nil || !strings.Contains(err.Error(), "target connection") {
			t.Errorf("missing/wrong peer error=%v", err)
		}
	}
	if len(manager.List()) != before {
		t.Fatal("invalid peer registered task")
	}
}

func TestStartRemoteRejectsSameConnection(t *testing.T) {
	manager, conn, _ := newAdmissionFixture(t)
	if _, err := manager.StartRemote(conn, "/from", conn, "/to"); err == nil || !strings.Contains(err.Error(), "same connection") {
		t.Fatalf("same endpoint error=%v", err)
	}
	if len(manager.List()) != 0 {
		t.Fatal("same endpoints registered task")
	}
}

func TestRetryRejectsActiveAndUnknownTasks(t *testing.T) {
	manager, conn, _ := newAdmissionFixture(t)
	if _, err := manager.Retry("missing", conn, nil); err == nil {
		t.Fatal("unknown task allowed")
	}
	for _, state := range []State{Queued, Running, Done} {
		task := &Task{ID: string(state), ConnectionID: conn.ID, Direction: ServerToServer, state: state}
		manager.addTask(task)
		before := len(manager.List())
		if _, err := manager.Retry(task.ID, conn, nil); err == nil || !strings.Contains(err.Error(), "only failed or cancelled") {
			t.Errorf("state=%s error=%v", state, err)
		}
		if len(manager.List()) != before {
			t.Fatal("active task retry registered task")
		}
	}
}
