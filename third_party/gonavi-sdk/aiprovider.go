package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"
)

// AIProviderDispatcher multiplexes up to eight providers through one bounded process-local pool.
// Abort is nonblocking and belongs in Options.OnClose. Close performs a bounded final join.
type AIProviderDispatcher struct {
	mu         sync.Mutex
	root       context.Context
	cancel     context.CancelFunc
	stopRoot   func() bool
	providers  map[string]AIProviderRegistration
	limits     AIProviderLimits
	sessions   map[string]*aiProviderSession
	live       map[string]*aiProviderSession
	tombstones map[string]string
	recent     []string
	workers    int
	idle       chan struct{}
	closed     bool
}

type aiProviderQueuedEvent struct {
	raw      json.RawMessage
	terminal bool
}
type aiProviderSession struct {
	key           string
	providerID    string
	ctx           context.Context
	cancel        context.CancelFunc
	changed       chan struct{}
	queue         []aiProviderQueuedEvent
	queueBytes    int
	totalBytes    int
	sequence      uint64
	terminal      bool
	closed        bool
	pulling       bool
	reason        string
	offered       map[string]bool
	supportsTools bool
	deadlineTimer *time.Timer
	idleTimer     *time.Timer
	lastPull      time.Time
}

// NewAIProviderDispatcher binds independent completion contexts to root, never to an initialize/start RPC.
func NewAIProviderDispatcher(root context.Context, options AIProviderOptions) (*AIProviderDispatcher, error) {
	if root == nil || len(options.Providers) == 0 || len(options.Providers) > 8 {
		return nil, aiProviderFailure("invalid_request")
	}
	if err := root.Err(); err != nil {
		return nil, err
	}
	limits, err := normalizeAIProviderLimits(options.Limits)
	if err != nil {
		return nil, err
	}
	providers := make(map[string]AIProviderRegistration, len(options.Providers))
	for id, registration := range options.Providers {
		if !aiProviderLocalID.MatchString(id) {
			return nil, aiProviderFailure("invalid_request")
		}
		registration, err = validateAIProviderRegistration(registration)
		if err != nil {
			return nil, err
		}
		providers[id] = registration
	}
	ctx, cancel := context.WithCancel(root)
	idle := make(chan struct{})
	close(idle)
	dispatcher := &AIProviderDispatcher{root: ctx, cancel: cancel, providers: providers, limits: limits, sessions: make(map[string]*aiProviderSession), live: make(map[string]*aiProviderSession), tombstones: make(map[string]string), idle: idle}
	dispatcher.mu.Lock()
	dispatcher.stopRoot = context.AfterFunc(ctx, dispatcher.Abort)
	dispatcher.mu.Unlock()
	return dispatcher, nil
}

// Handle implements the reserved command's start/pull/cancel envelope. No data is emitted as stdout notifications.
func (d *AIProviderDispatcher) Handle(ctx context.Context, raw json.RawMessage) (any, error) {
	if ctx == nil {
		return nil, aiProviderRPCError("invalid_request")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	envelope, err := parseAIProviderEnvelope(raw)
	if err != nil {
		var failure *AIProviderFailure
		if errors.As(err, &failure) {
			return nil, aiProviderRPCError(failure.Code)
		}
		return nil, aiProviderRPCError("invalid_request")
	}
	registration, exists := d.providers[envelope.ProviderID]
	if !exists {
		return nil, aiProviderRPCError("unsupported")
	}
	key := envelope.ProviderID + "\x00" + envelope.RequestID
	switch envelope.Operation {
	case "start":
		start, offered, err := validateAIProviderStart(envelope, registration)
		if err != nil {
			var failure *AIProviderFailure
			if errors.As(err, &failure) {
				return nil, aiProviderRPCError(failure.Code)
			}
			return nil, aiProviderRPCError("invalid_request")
		}
		return d.start(ctx, key, start, offered, registration)
	case "pull":
		return d.pull(ctx, key)
	case "cancel":
		d.mu.Lock()
		if session := d.sessions[key]; session != nil {
			d.removeLocked(session, "canceled")
		} else {
			d.rememberLocked(key, "canceled")
		}
		d.mu.Unlock()
		return map[string]bool{"ok": true}, nil
	}
	return nil, aiProviderRPCError("unsupported")
}

func (d *AIProviderDispatcher) start(ctx context.Context, key string, start AIProviderStart, offered map[string]bool, registration AIProviderRegistration) (any, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if d.closed || d.root.Err() != nil {
		return nil, aiProviderRPCError("canceled")
	}
	if _, exists := d.tombstones[key]; exists {
		return nil, aiProviderRPCError("invalid_request")
	}
	if d.sessions[key] != nil || d.live[key] != nil {
		return nil, aiProviderRPCError("invalid_request")
	}
	if d.workers >= d.limits.MaxWorkers || len(d.sessions) >= d.limits.MaxSessions {
		return nil, aiProviderRPCError("limit_exceeded")
	}
	worker, cancel := context.WithTimeout(d.root, d.limits.Duration)
	session := &aiProviderSession{key: key, providerID: start.ProviderID, ctx: worker, cancel: cancel, changed: make(chan struct{}), offered: offered, supportsTools: registration.SupportsTools, lastPull: time.Now()}
	d.sessions[key] = session
	d.live[key] = session
	session.deadlineTimer = time.AfterFunc(d.limits.Duration, func() { d.expire(session, false) })
	session.idleTimer = time.AfterFunc(d.limits.IdleLease, func() { d.expire(session, true) })
	if d.workers == 0 {
		d.idle = make(chan struct{})
	}
	d.workers++
	go d.generate(session, start, registration.Generate)
	return map[string]bool{"accepted": true}, nil
}

func (d *AIProviderDispatcher) generate(session *aiProviderSession, start AIProviderStart, generate AIProviderGenerate) {
	defer func() {
		d.mu.Lock()
		d.workers--
		if d.live[session.key] == session {
			delete(d.live, session.key)
		}
		if d.workers == 0 {
			close(d.idle)
		}
		d.mu.Unlock()
	}()
	completion, err := callAIProviderGenerate(session.ctx, start, func(delta AIProviderDelta) error { return d.emit(session, delta) }, generate)
	if err == nil {
		err = validateAIProviderCompletion(completion, session.offered, session.supportsTools)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	if session.closed || session.terminal {
		return
	}
	if err != nil || session.ctx.Err() != nil {
		d.failLocked(session, aiProviderErrorCode(session.ctx, err))
		return
	}
	event := AIProviderEvent{Type: "done", FinishReason: completion.FinishReason, ToolCalls: completion.ToolCalls, Usage: completion.Usage}
	d.terminalLocked(session, event)
}

func callAIProviderGenerate(ctx context.Context, start AIProviderStart, emit AIProviderEmit, generate AIProviderGenerate) (completion AIProviderCompletion, err error) {
	defer func() {
		if recover() != nil {
			completion = AIProviderCompletion{}
			err = aiProviderFailure("generation_failed")
		}
	}()
	if err = ctx.Err(); err != nil {
		return completion, err
	}
	return generate(ctx, start, emit)
}

func (d *AIProviderDispatcher) notifyLocked(session *aiProviderSession) {
	close(session.changed)
	session.changed = make(chan struct{})
}

func (d *AIProviderDispatcher) rememberLocked(key, reason string) {
	if _, exists := d.tombstones[key]; exists {
		return
	}
	d.tombstones[key] = reason
	d.recent = append(d.recent, key)
	for len(d.recent) > d.limits.Tombstones {
		oldest := d.recent[0]
		d.recent = d.recent[1:]
		delete(d.tombstones, oldest)
	}
}

func (d *AIProviderDispatcher) removeLocked(session *aiProviderSession, reason string) {
	if session.closed {
		return
	}
	session.closed = true
	session.reason = reason
	session.queue = nil
	session.queueBytes = 0
	session.cancel()
	if session.deadlineTimer != nil {
		session.deadlineTimer.Stop()
	}
	if session.idleTimer != nil {
		session.idleTimer.Stop()
	}
	if d.sessions[session.key] == session {
		delete(d.sessions, session.key)
	}
	d.rememberLocked(session.key, reason)
	d.notifyLocked(session)
}

func (d *AIProviderDispatcher) expire(session *aiProviderSession, idle bool) {
	d.mu.Lock()
	defer d.mu.Unlock()
	if session.closed || d.sessions[session.key] != session {
		return
	}
	if idle {
		remaining := time.Until(session.lastPull.Add(d.limits.IdleLease))
		if remaining > 0 {
			session.idleTimer.Reset(remaining)
			return
		}
	}
	d.removeLocked(session, "deadline")
}

// Abort cancels jobs, stops timers and wakes Emit/Pull without waiting for uncooperative callbacks.
func (d *AIProviderDispatcher) Abort() {
	d.mu.Lock()
	if d.closed {
		d.mu.Unlock()
		return
	}
	d.closed = true
	for _, session := range d.sessions {
		d.removeLocked(session, "canceled")
	}
	stopRoot := d.stopRoot
	d.stopRoot = nil
	d.mu.Unlock()
	d.cancel()
	if stopRoot != nil {
		stopRoot()
	}
}

// Close aborts and waits at most CloseWait (never above two seconds). A timed-out worker still owns its slot.
func (d *AIProviderDispatcher) Close(ctx context.Context) error {
	d.Abort()
	if ctx == nil {
		return aiProviderFailure("invalid_request")
	}
	d.mu.Lock()
	idle := d.idle
	d.mu.Unlock()
	timer := time.NewTimer(d.limits.CloseWait)
	defer timer.Stop()
	select {
	case <-idle:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return aiProviderFailure("deadline")
	}
}
