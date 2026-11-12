package sshclient

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"gonavi-ssh/internal/profile"
)

func registerRetirementConn(t *testing.T, manager *Manager, id string) *Conn {
	t.Helper()
	client, _ := blackholeJump(t)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	pend := &Pending{ID: id, ProfileID: "profile", ctx: ctx, cancel: cancel, done: make(chan struct{})}
	manager.mu.Lock()
	manager.pending[id] = pend
	manager.byProfilePending[pend.ProfileID] = pend
	manager.mu.Unlock()
	manager.finishDial(pend, profile.Profile{ID: pend.ProfileID}, client, nil, nil)
	conn, ok := manager.Get(id)
	if !ok {
		t.Fatal("connection was not registered")
	}
	return conn
}

func TestConnectionRetirementIsIdempotentAndKeepsReplacement(t *testing.T) {
	manager, err := NewManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(manager.CloseAll)
	old := registerRetirementConn(t, manager, "old")
	next := registerRetirementConn(t, manager, "replacement")
	entered := make(chan struct{}, 2)
	release := make(chan struct{})
	defer close(release)
	var oldCallbacks atomic.Int32
	manager.OnDead(func(id string) {
		if id != old.ID {
			return
		}
		oldCallbacks.Add(1)
		if got := manager.Status(old.ID); len(got) != 0 {
			t.Errorf("callback ran before retirement: %+v", got)
		}
		entered <- struct{}{}
		<-release // slow resource cleanup must not block Close
	})
	closed := make(chan struct{})
	go func() { old.Close(); old.Close(); close(closed) }()
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("Close waited for resource cleanup")
	}
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("Close skipped resource cleanup")
	}
	if oldCallbacks.Load() != 1 {
		t.Fatalf("cleanup called %d times", oldCallbacks.Load())
	}
	if got := manager.Status(""); len(got) != 1 || got[0].ConnectionID != next.ID || !got[0].Alive {
		t.Fatalf("old connection retirement damaged replacement: %+v", got)
	}
	manager.mu.Lock()
	indexed := manager.byProfile[next.ProfileID]
	manager.mu.Unlock()
	if indexed != next {
		t.Fatal("old connection retirement removed replacement profile index")
	}
}
