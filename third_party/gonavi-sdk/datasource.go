package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"
)

// DataSourceDispatcher guards session identity and cancellation around typed provider callbacks.
// One dispatcher serves one contribution in one plugin process. It permits 128 active sessions and
// retains 4096 recent settled tombstones. In-flight closed records remain fenced until callbacks return.
// It does not provide SQL classification, credential storage, transactions, writes or transport forwarding.
type DataSourceDispatcher struct {
	mu         sync.Mutex
	operations DataSourceOperations
	sessions   map[string]*dataSourceSession
	active     int
	connecting int
	tombstones []string
	sequence   uint64
	stopped    bool
}

type dataSourceSession struct {
	ready, closed, remembered bool
	calls                     map[uint64]context.CancelFunc
}

// NewDataSourceDispatcher constructs a process-local dispatcher. Register its Handle method as the manifest command.
func NewDataSourceDispatcher(operations DataSourceOperations) *DataSourceDispatcher {
	return &DataSourceDispatcher{operations: operations, sessions: make(map[string]*dataSourceSession)}
}

// Handle implements Handler without blocking the SDK control reader. Callbacks must cooperate with cancellation.
func (d *DataSourceDispatcher) Handle(ctx context.Context, raw json.RawMessage) (any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	request, err := decodeDataSourceRequest(raw)
	if err != nil {
		return nil, err
	}
	if request.Operation == "connect" {
		return d.connect(ctx, request)
	}
	if request.Operation == "close" {
		return d.closeSession(ctx, request)
	}
	d.mu.Lock()
	session := d.sessions[request.SessionID]
	if d.stopped || session == nil || session.closed || !session.ready {
		d.mu.Unlock()
		return nil, ErrDataSourceSession
	}
	child, cancel, key := d.callLocked(ctx, session)
	d.mu.Unlock()
	defer cancel()
	value, err := callHandler(child, func(ctx context.Context, _ json.RawMessage) (any, error) { return d.dispatch(ctx, request) }, nil)
	d.mu.Lock()
	delete(session.calls, key)
	closed := session.closed || d.stopped || d.sessions[request.SessionID] != session
	d.rememberClosedLocked(request.SessionID, session)
	d.mu.Unlock()
	if child.Err() != nil {
		return nil, child.Err()
	}
	if closed {
		return nil, context.Canceled
	}
	return boundedDataSourceResult(value, err)
}

func (d *DataSourceDispatcher) callLocked(ctx context.Context, session *dataSourceSession) (context.Context, context.CancelFunc, uint64) {
	child, cancel := context.WithCancel(ctx)
	d.sequence++
	session.calls[d.sequence] = cancel
	return child, cancel, d.sequence
}

func (d *DataSourceDispatcher) connect(ctx context.Context, r DataSourceRequest) (any, error) {
	if d.operations.Connect == nil || d.operations.Close == nil {
		return nil, ErrDataSourceUnsupported
	}
	d.mu.Lock()
	if d.stopped || d.sessions[r.SessionID] != nil {
		d.mu.Unlock()
		return nil, ErrDataSourceSession
	}
	if d.active >= 128 || d.connecting >= 128 {
		d.mu.Unlock()
		return nil, ErrDataSourceLimit
	}
	session := &dataSourceSession{calls: make(map[uint64]context.CancelFunc)}
	d.sessions[r.SessionID] = session
	d.active++
	d.connecting++
	child, cancel, key := d.callLocked(ctx, session)
	d.mu.Unlock()
	defer cancel()
	_, err := callHandler(child, func(ctx context.Context, _ json.RawMessage) (any, error) { return nil, d.operations.Connect(ctx, r) }, nil)
	d.mu.Lock()
	delete(session.calls, key)
	d.connecting--
	if child.Err() != nil {
		err = child.Err()
	} else if session.closed || d.stopped || d.sessions[r.SessionID] != session {
		err = context.Canceled
	}
	if err == nil {
		session.ready = true
	} else if !session.closed {
		session.closed = true
		d.active--
	}
	d.rememberClosedLocked(r.SessionID, session)
	d.mu.Unlock()
	if err != nil {
		// Cleanup belongs to the acquired resource, not the canceled request. Keep it bounded.
		cleanup, stop := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Second)
		defer stop()
		cleanupErr := d.closeProvider(cleanup, DataSourceRequest{ProtocolVersion: 1, Operation: "close", SessionID: r.SessionID})
		return nil, errors.Join(err, cleanupErr)
	}
	return map[string]bool{"ok": true}, nil
}

func (d *DataSourceDispatcher) closeSession(ctx context.Context, r DataSourceRequest) (any, error) {
	d.mu.Lock()
	session := d.sessions[r.SessionID]
	if session == nil {
		session = &dataSourceSession{calls: make(map[uint64]context.CancelFunc)}
		d.sessions[r.SessionID] = session
	} else if session.closed {
		d.mu.Unlock()
		return map[string]bool{"ok": true}, nil
	} else {
		d.active--
	}
	session.closed = true
	for _, cancel := range session.calls {
		cancel()
	}
	d.rememberClosedLocked(r.SessionID, session)
	d.mu.Unlock()
	if d.operations.Close == nil {
		return nil, ErrDataSourceUnsupported
	}
	err := d.closeProvider(ctx, r)
	if err != nil {
		return nil, err
	}
	return map[string]bool{"ok": true}, nil
}

func (d *DataSourceDispatcher) closeProvider(ctx context.Context, request DataSourceRequest) error {
	_, err := callHandler(ctx, func(ctx context.Context, _ json.RawMessage) (any, error) {
		return nil, d.operations.Close(ctx, request)
	}, nil)
	return err
}

func (d *DataSourceDispatcher) rememberClosedLocked(id string, session *dataSourceSession) {
	if !session.closed || len(session.calls) != 0 || session.remembered {
		return
	}
	session.remembered = true
	d.tombstones = append(d.tombstones, id)
	for len(d.tombstones) > 4096 {
		oldest := d.tombstones[0]
		d.tombstones = d.tombstones[1:]
		if record := d.sessions[oldest]; record != nil && record.closed && len(record.calls) == 0 {
			delete(d.sessions, oldest)
		}
	}
}

// Close stops new work, cancels active calls, and closes provider resources outside the state lock.
// It is process cleanup, not a transaction rollback or a guarantee that cancellation-ignoring code has stopped.
func (d *DataSourceDispatcher) Close(ctx context.Context) error {
	d.mu.Lock()
	d.stopped = true
	ids := make([]string, 0, d.active)
	for id, session := range d.sessions {
		if session.closed {
			continue
		}
		session.closed = true
		ids = append(ids, id)
		for _, cancel := range session.calls {
			cancel()
		}
		d.rememberClosedLocked(id, session)
	}
	d.active = 0
	d.mu.Unlock()
	if len(ids) == 0 {
		return nil
	}
	if d.operations.Close == nil {
		return ErrDataSourceUnsupported
	}
	var failures []error
	for _, id := range ids {
		if err := ctx.Err(); err != nil {
			return errors.Join(append(failures, err)...)
		}
		if err := d.closeProvider(ctx, DataSourceRequest{ProtocolVersion: 1, Operation: "close", SessionID: id}); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}
