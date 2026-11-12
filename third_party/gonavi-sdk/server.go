package plugin

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"time"
)

// Handler must honor cancellation and is called outside the control reader.
// Handlers can run concurrently; they must synchronize their shared state.
type Handler func(context.Context, json.RawMessage) (any, error)

// Options configures bounded request handling. Initialize runs asynchronously.
// A zero limit selects the documented default, not an unbounded queue.
type Options struct {
	Handlers   map[string]Handler
	Initialize func(context.Context, InitializeParams) error
	// OnLifecycle is optional and must return quickly. Only event "running" is delivered.
	OnLifecycle func(context.Context, string, uint64)
	// OnClose must be nonblocking (for example dispatcher.Abort), never a join.
	// It runs once on every Serve exit and before handler joins.
	OnClose         func()
	MaxConcurrent   int
	MaxFrameBytes   int
	ShutdownTimeout time.Duration
}

// Server serves a single host connection. Construct a new server per instance.
type Server struct{ options Options }

// NewServer copies the handler registry so later map edits cannot race serving.
func NewServer(options Options) *Server {
	handlers := make(map[string]Handler, len(options.Handlers))
	for name, handler := range options.Handlers {
		handlers[name] = handler
	}
	options.Handlers = handlers
	if options.MaxConcurrent <= 0 {
		options.MaxConcurrent = 32
	}
	if options.MaxFrameBytes <= 0 {
		options.MaxFrameBytes = DefaultMaxFrameBytes
	}
	if options.ShutdownTimeout <= 0 {
		options.ShutdownTimeout = 2 * time.Second
	}
	return &Server{options: options}
}

// ServeStdio serves the host pipe and reserves stdout exclusively for JSON-RPC.
// It closes stdin/stdout on return; main should then exit the plugin process.
func (s *Server) ServeStdio(ctx context.Context) error { return s.Serve(ctx, os.Stdin, os.Stdout) }

// Serve owns and closes both streams. Close must unblock concurrent Read/Write.
// Cancellation reaches all handlers. After ShutdownTimeout, Serve returns even
// if a handler ignores its context; only process exit can stop such Go code.
func (s *Server) Serve(ctx context.Context, input io.ReadCloser, output io.WriteCloser) error {
	run := newSession(s.options, func() {})
	defer run.closeRoots()
	if ctx == nil || input == nil || output == nil {
		return errors.New("context and streams are required")
	}
	child, cancel := context.WithCancel(ctx)
	defer cancel()
	run.cancel = cancel
	stopIO := context.AfterFunc(child, func() { run.closeStreams(input, output) })
	defer stopIO()
	go run.writeLoop(child, output)
	err := run.readLoop(child, input)
	cancel()
	run.closeRoots()
	run.closeStreams(input, output)
	<-run.writerDone
	cleanupErr := run.waitHandlers()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if failure := run.failure(); failure != nil {
		return failure
	}
	if err != nil {
		return err
	}
	return cleanupErr
}

type outgoing struct {
	frame   []byte
	flushed chan struct{}
}

type session struct {
	options       Options
	cancel        context.CancelFunc
	mu            sync.Mutex
	active        map[string]context.CancelFunc
	initialized   bool
	initializing  bool
	stopped       bool
	fatal         error
	closeOnce     sync.Once
	rootCloseOnce sync.Once
	workers       sync.WaitGroup
	queue         chan outgoing
	writerDone    chan struct{}
	hostPending   map[string]chan hostCallResult
	hostSeq       uint64
}

func newSession(options Options, cancel context.CancelFunc) *session {
	return &session{options: options, cancel: cancel, active: make(map[string]context.CancelFunc),
		// Allow a bounded burst of responses while the writer catches up. A full
		// queue fails closed instead of blocking heartbeat/cancellation dispatch.
		queue: make(chan outgoing, 64), writerDone: make(chan struct{})}
}

func (s *session) closeStreams(input io.ReadCloser, output io.WriteCloser) {
	s.closeOnce.Do(func() {
		if err := input.Close(); err != nil && !errors.Is(err, os.ErrClosed) {
			s.recordFailure(fmt.Errorf("close input: %w", err))
		}
		if err := output.Close(); err != nil && !errors.Is(err, os.ErrClosed) {
			s.recordFailure(fmt.Errorf("close output: %w", err))
		}
	})
}

func (s *session) recordFailure(err error) {
	s.mu.Lock()
	if s.fatal == nil {
		s.fatal = err
	}
	s.mu.Unlock()
}

func (s *session) failure() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.fatal
}

func (s *session) readLoop(ctx context.Context, input io.Reader) error {
	scanner := bufio.NewScanner(input)
	scanner.Buffer(make([]byte, 4096), s.options.MaxFrameBytes+2)
	for scanner.Scan() {
		if ctx.Err() != nil {
			return nil
		}
		frame := scanner.Bytes()
		if len(frame) > s.options.MaxFrameBytes {
			return errors.New("request exceeds frame limit")
		}
		if s.deliverHostResponse(frame) {
			continue
		}
		req, err := parseRequest(frame)
		if err != nil {
			s.respond(ctx, nil, nil, err, nil)
			continue
		}
		if s.dispatch(ctx, req) {
			return nil
		}
	}
	if err := scanner.Err(); err != nil && ctx.Err() == nil {
		return fmt.Errorf("read protocol frame: %w", err)
	}
	return nil
}

func (s *session) writeLoop(ctx context.Context, output io.Writer) {
	defer close(s.writerDone)
	for {
		select {
		case <-ctx.Done():
			return
		case item := <-s.queue:
			if err := writeFrame(output, item.frame); err != nil {
				if ctx.Err() == nil {
					s.recordFailure(err)
				}
				s.cancel()
				return
			}
			if item.flushed != nil {
				close(item.flushed)
			}
		}
	}
}

func (s *session) respond(ctx context.Context, id json.RawMessage, value any, err error, flushed chan struct{}) {
	frame, encodeErr := encodeResponse(id, value, err, s.options.MaxFrameBytes)
	if encodeErr != nil {
		s.recordFailure(encodeErr)
		s.cancel()
		return
	}
	select {
	case <-ctx.Done():
	case s.queue <- outgoing{frame: frame, flushed: flushed}:
	default:
		s.recordFailure(errors.New("protocol output queue is full"))
		s.cancel()
	}
}

func (s *session) waitHandlers() error {
	done := make(chan struct{})
	go func() { s.workers.Wait(); close(done) }()
	timer := time.NewTimer(s.options.ShutdownTimeout)
	defer timer.Stop()
	select {
	case <-done:
		return nil
	case <-timer.C:
		return errors.New("handlers ignored cancellation; exit the plugin process")
	}
}
