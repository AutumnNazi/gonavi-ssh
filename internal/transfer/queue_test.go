package transfer

import (
	"errors"
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"gonavi-ssh/internal/sshclient"
)

type queueProvider struct {
	entered chan string
	release chan struct{}
}

func (p *queueProvider) Client(c *sshclient.Conn) (*sftp.Client, error) {
	p.entered <- c.ID
	<-p.release
	return nil, errors.New("fixture finished")
}

func awaitQueueEntry(t *testing.T, entries <-chan string) string {
	t.Helper()
	select {
	case id := <-entries:
		return id
	case <-time.After(3 * time.Second):
		t.Fatal("transfer did not start")
		return ""
	}
}

func TestQueueBoundsRunningTransfersAndCancelsWaiting(t *testing.T) {
	p := &queueProvider{entered: make(chan string, 8), release: make(chan struct{})}
	m := NewManager(p)
	defer close(p.release)
	tasks := make([]*Task, 8)
	for i := range tasks {
		var err error
		tasks[i], err = m.Start(&sshclient.Conn{ID: fmt.Sprint(i)}, Download, "/file", filepath.Join(t.TempDir(), "file"), func(string) bool { return true })
		if err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 4; i++ {
		awaitQueueEntry(t, p.entered)
	}
	running, queued := 0, 0
	for _, task := range tasks {
		if task.snapshot().State == Running {
			running++
		} else {
			queued++
			if err := m.Cancel(task.ID); err != nil {
				t.Fatal(err)
			}
			if st := waitAdmissionTask(t, task); st.State != Cancelled {
				t.Fatalf("queued cancellation=%s", st.State)
			}
		}
	}
	if running != 4 || queued != 4 {
		t.Fatalf("running=%d queued=%d", running, queued)
	}
	select {
	case <-p.entered:
		t.Fatal("queued transfer acquired network resources")
	default:
	}
}

func TestQueueSerializesNormalizedLocalDestination(t *testing.T) {
	p := &queueProvider{entered: make(chan string, 2), release: make(chan struct{})}
	m := NewManager(p)
	defer close(p.release)
	dir := t.TempDir()
	first, err := m.Start(&sshclient.Conn{ID: "first"}, Download, "/a", filepath.Join(dir, "file"), func(string) bool { return true })
	if err != nil {
		t.Fatal(err)
	}
	if got := awaitQueueEntry(t, p.entered); got != "first" {
		t.Fatal(got)
	}
	second, err := m.Start(&sshclient.Conn{ID: "second"}, Download, "/b", dir+string(filepath.Separator)+"."+string(filepath.Separator)+"file", func(string) bool { return true })
	if err != nil {
		t.Fatal(err)
	}
	select {
	case <-p.entered:
		t.Fatal("two writers entered the same target")
	case <-time.After(30 * time.Millisecond):
	}
	if second.snapshot().State != Queued {
		t.Fatal("second transfer should stay queued")
	}
	p.release <- struct{}{}
	if got := awaitQueueEntry(t, p.entered); got != "second" {
		t.Fatal(got)
	}
	if st := waitAdmissionTask(t, first); st.State != Failed {
		t.Fatal(st.State)
	}
}

func TestQueueRejectsExcessPendingWork(t *testing.T) {
	m := NewManager(nil)
	for i := 0; i < 200; i++ {
		if err := m.addTask(&Task{ID: fmt.Sprint(i), state: Queued}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := m.Start(&sshclient.Conn{ID: "conn"}, Upload, "/target", "local", func(string) bool { return true }); err == nil {
		t.Fatal("expected full queue rejection")
	}
	if len(m.List()) != 200 {
		t.Fatal("rejected work was registered")
	}
}

func TestQueueLimitsEachConnectionWithoutBlockingOtherConnections(t *testing.T) {
	p := &queueProvider{entered: make(chan string, 8), release: make(chan struct{})}
	m := NewManager(p)
	defer close(p.release)
	start := func(connID string) *Task {
		t.Helper()
		task, err := m.Start(&sshclient.Conn{ID: connID}, Download, "/file", filepath.Join(t.TempDir(), "file"), func(string) bool { return true })
		if err != nil {
			t.Fatal(err)
		}
		return task
	}
	for i := 0; i < 2; i++ {
		start("busy")
		if got := awaitQueueEntry(t, p.entered); got != "busy" {
			t.Fatal(got)
		}
	}
	waiting := start("busy")
	for i := 0; i < 2; i++ {
		start("other")
		if got := awaitQueueEntry(t, p.entered); got != "other" {
			t.Fatalf("busy connection used another worker: %s", got)
		}
	}
	if waiting.snapshot().State != Queued {
		t.Fatal("third transfer must remain queued")
	}
	if err := m.Cancel(waiting.ID); err != nil {
		t.Fatal(err)
	}
	if got := waitAdmissionTask(t, waiting); got.State != Cancelled {
		t.Fatal(got.State)
	}
}

func TestRemoteTransferReservesBothConnectionLimits(t *testing.T) {
	for _, endpoint := range []string{"source", "peer"} {
		t.Run(endpoint, func(t *testing.T) {
			p := &queueProvider{entered: make(chan string, 8), release: make(chan struct{})}
			m := NewManager(p)
			defer close(p.release)
			for i := 0; i < 2; i++ {
				source, peer := &sshclient.Conn{ID: fmt.Sprintf("source-%d", i)}, &sshclient.Conn{ID: fmt.Sprintf("peer-%d", i)}
				if endpoint == "source" {
					source.ID = "busy"
				} else {
					peer.ID = "busy"
				}
				if _, err := m.StartRemote(source, "/source", peer, fmt.Sprintf("/target-%d", i)); err != nil {
					t.Fatal(err)
				}
				if got := awaitQueueEntry(t, p.entered); got != source.ID {
					t.Fatal(got)
				}
			}
			waiting, err := m.Start(&sshclient.Conn{ID: "busy"}, Download, "/file", filepath.Join(t.TempDir(), "waiting"), func(string) bool { return true })
			if err != nil {
				t.Fatal(err)
			}
			if _, err := m.Start(&sshclient.Conn{ID: "free"}, Download, "/file", filepath.Join(t.TempDir(), "free"), func(string) bool { return true }); err != nil {
				t.Fatal(err)
			}
			if got := awaitQueueEntry(t, p.entered); got != "free" {
				t.Fatalf("remote endpoint exceeded capacity: %s", got)
			}
			if waiting.snapshot().State != Queued {
				t.Fatal("busy endpoint did not reserve both slots")
			}
			if err := m.Cancel(waiting.ID); err != nil {
				t.Fatal(err)
			}
			if got := waitAdmissionTask(t, waiting); got.State != Cancelled {
				t.Fatal(got.State)
			}
		})
	}
}
