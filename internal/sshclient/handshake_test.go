package sshclient

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func TestHandshakeHandoffStopsLateCallbacks(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var closed atomic.Int32
	guard := newHandshakeGuard(ctx, func() { closed.Add(1) })
	if err := guard.finish(ctx); err != nil {
		t.Fatal(err)
	}
	cancel()
	guard.abort()
	guard.reset(time.Millisecond)
	if closed.Load() != 0 {
		t.Fatal("late callback closed handed-off client")
	}
}

func TestHandshakeHandoffWaitsForAbortingClose(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	entered, release := make(chan struct{}), make(chan struct{})
	guard := newHandshakeGuard(ctx, func() { close(entered); <-release })
	cancel()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("cancel close did not start")
	}
	done := make(chan error, 1)
	go func() { done <- guard.finish(ctx) }()
	select {
	case <-done:
		t.Fatal("handoff returned during transport close")
	default:
	}
	close(release)
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("error=%v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("handoff did not stop")
	}
}

func TestHandshakeTimeoutCannotBeRevivedByInteractiveReset(t *testing.T) {
	var closed atomic.Int32
	guard := newHandshakeGuard(context.Background(), func() { closed.Add(1) })
	guard.abort()
	guard.reset(dialTimeout + interactiveTimeout)
	if err := guard.finish(context.Background()); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("error=%v", err)
	}
	if closed.Load() != 1 {
		t.Fatalf("closed %d times", closed.Load())
	}
}
