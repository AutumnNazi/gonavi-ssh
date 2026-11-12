package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"time"
)

func (s *session) dispatch(ctx context.Context, req request) bool {
	if req.Method == "$/cancelRequest" {
		s.cancelRequest(req.Params)
		return false
	}
	// These methods are requests, not notifications. Never acknowledge a
	// notification or run a notification as a write-bearing invocation.
	if len(req.ID) == 0 {
		if req.Method == "plugin.lifecycle" {
			s.deliverLifecycle(ctx, req.Params)
		}
		return false
	}
	switch req.Method {
	case "plugin.ping":
		s.respond(ctx, req.ID, struct{}{}, nil, nil)
	case "plugin.initialize":
		s.initialize(ctx, req)
	case "plugin.invoke":
		s.invoke(ctx, req)
	case "plugin.shutdown":
		return s.shutdown(ctx, req)
	default:
		s.respond(ctx, req.ID, nil, &Error{Code: -32601, Message: "method not found"}, nil)
	}
	return false
}

func (s *session) cancelRequest(params json.RawMessage) {
	var request struct {
		ID json.RawMessage `json:"id"`
	}
	if decodeParams(params, &request) != nil || !validID(request.ID) {
		return
	}
	s.mu.Lock()
	cancel := s.active[requestKey(request.ID)]
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
}

func (s *session) initialize(ctx context.Context, req request) {
	var params InitializeParams
	if err := decodeParams(req.Params, &params); err != nil {
		s.respond(ctx, req.ID, nil, err, nil)
		return
	}
	if params.APIVersion != APIVersion || params.PluginID == "" {
		s.respond(ctx, req.ID, nil, &Error{Code: -32602, Message: "unsupported initialization"}, nil)
		return
	}
	s.mu.Lock()
	duplicate := s.initialized || s.initializing || s.stopped
	if !duplicate {
		s.initializing = true
	}
	s.mu.Unlock()
	if duplicate {
		s.respond(ctx, req.ID, nil, &Error{Code: -32600, Message: "already initialized"}, nil)
		return
	}
	s.start(ctx, req, func(ctx context.Context, _ json.RawMessage) (any, error) {
		var err error
		if s.options.Initialize != nil {
			_, err = callHandler(ctx, func(ctx context.Context, _ json.RawMessage) (any, error) {
				return nil, s.options.Initialize(ctx, params)
			}, nil)
		}
		s.mu.Lock()
		s.initializing = false
		s.initialized = err == nil && ctx.Err() == nil && !s.stopped
		s.mu.Unlock()
		return struct {
			APIVersion int `json:"apiVersion"`
		}{APIVersion: APIVersion}, err
	}, nil)
}

func (s *session) invoke(ctx context.Context, req request) {
	s.mu.Lock()
	ready := s.initialized && !s.stopped
	s.mu.Unlock()
	if !ready {
		s.respond(ctx, req.ID, nil, &Error{Code: -32002, Message: "plugin is not initialized"}, nil)
		return
	}
	var params InvokeParams
	if err := decodeParams(req.Params, &params); err != nil {
		s.respond(ctx, req.ID, nil, err, nil)
		return
	}
	handler := s.options.Handlers[params.CommandID]
	if handler == nil {
		s.respond(ctx, req.ID, nil, &Error{Code: -32601, Message: "command not found"}, nil)
		return
	}
	if len(params.Arguments) == 0 {
		params.Arguments = json.RawMessage("null")
	}
	s.start(ctx, req, handler, params.Arguments)
}

func (s *session) start(ctx context.Context, req request, handler Handler, args json.RawMessage) {
	child, cancel := context.WithCancel(withHost(ctx, s))
	key := requestKey(req.ID)
	s.mu.Lock()
	_, duplicate := s.active[key]
	full := len(s.active) >= s.options.MaxConcurrent
	if !duplicate && !full {
		s.active[key] = cancel
	}
	s.mu.Unlock()
	if duplicate || full {
		cancel()
		s.respond(ctx, req.ID, nil, &Error{Code: -32001, Message: "duplicate request or concurrency limit"}, nil)
		return
	}
	s.workers.Add(1)
	go func() {
		defer s.workers.Done()
		defer cancel()
		result, err := callHandler(child, handler, args)
		if child.Err() != nil {
			err = &Error{Code: -32800, Message: "request cancelled"}
		}
		s.mu.Lock()
		delete(s.active, key)
		s.mu.Unlock()
		s.respond(ctx, req.ID, result, err, nil)
	}()
}

func callHandler(ctx context.Context, handler Handler, args json.RawMessage) (result any, err error) {
	defer func() {
		if recover() != nil {
			result = nil
			err = errors.New("handler panicked")
		}
	}()
	return handler(ctx, args)
}

func (s *session) shutdown(ctx context.Context, req request) bool {
	s.mu.Lock()
	s.stopped = true
	cancels := make([]context.CancelFunc, 0, len(s.active))
	for _, cancel := range s.active {
		cancels = append(cancels, cancel)
	}
	s.mu.Unlock()
	for _, cancel := range cancels {
		cancel()
	}
	s.closeRoots()
	flushed := make(chan struct{})
	s.respond(ctx, req.ID, struct{}{}, nil, flushed)
	timer := time.NewTimer(s.options.ShutdownTimeout)
	defer timer.Stop()
	select {
	case <-flushed:
	case <-ctx.Done():
	case <-timer.C:
		s.recordFailure(errors.New("shutdown response blocked"))
	}
	return true
}
