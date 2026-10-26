package sshclient

import (
	"context"
	"sync"
	"time"
)

// handshakeGuard keeps timeout/cancel callbacks from closing a handed-off client.
type handshakeGuard struct {
	mu      sync.Mutex
	active  bool
	aborted bool
	done    chan struct{}
	timer   *time.Timer
	stopCtx func() bool
	close   func()
}

func newHandshakeGuard(ctx context.Context, closeTransport func()) *handshakeGuard {
	g := &handshakeGuard{active: true, done: make(chan struct{}), close: closeTransport}
	g.timer = time.AfterFunc(dialTimeout, g.abort)
	g.stopCtx = context.AfterFunc(ctx, g.abort)
	return g
}

func (g *handshakeGuard) abort() {
	g.mu.Lock()
	if !g.active {
		g.mu.Unlock()
		return
	}
	g.active = false
	g.aborted = true
	g.mu.Unlock()
	g.close()
	close(g.done)
}

func (g *handshakeGuard) reset(timeout time.Duration) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.active {
		g.timer.Reset(timeout)
	}
}

func (g *handshakeGuard) finish(ctx context.Context) error {
	g.mu.Lock()
	g.active = false
	aborted := g.aborted
	g.timer.Stop()
	g.stopCtx()
	g.mu.Unlock()
	if aborted {
		<-g.done
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if aborted {
		return context.DeadlineExceeded
	}
	return nil
}
