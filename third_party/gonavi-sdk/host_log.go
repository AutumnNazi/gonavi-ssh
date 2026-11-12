package plugin

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"unicode/utf8"
)

type hostKey struct{}

type hostCallResult struct {
	raw json.RawMessage
	err error
}

// Host is the caller-bound gateway available to a running handler.
type Host struct{ session *session }

// HostFromContext returns the gateway for the active handler.
func HostFromContext(ctx context.Context) (*Host, bool) {
	if ctx == nil {
		return nil, false
	}
	host, ok := ctx.Value(hostKey{}).(*Host)
	return host, ok && host != nil && host.session != nil
}

func withHost(ctx context.Context, session *session) context.Context {
	return context.WithValue(ctx, hostKey{}, &Host{session: session})
}

// Log sends one bounded diagnostic. It does not grant any other host method.
func (h *Host) Log(ctx context.Context, level, message string) error {
	if h == nil || h.session == nil || ctx == nil {
		return errors.New("host log is unavailable")
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if level != "info" && level != "warn" {
		return errors.New("host log level must be info or warn")
	}
	if message == "" || len(message) > 1024 || !utf8.ValidString(message) || strings.ContainsRune(message, 0) {
		return errors.New("host log message is empty, too long, or not valid UTF-8")
	}
	h.session.mu.Lock()
	h.session.hostSeq++
	id := "hl-" + uintString(h.session.hostSeq)
	if h.session.hostPending == nil {
		h.session.hostPending = make(map[string]chan hostCallResult)
	}
	reply := make(chan hostCallResult, 1)
	h.session.hostPending[id] = reply
	h.session.mu.Unlock()
	defer h.session.forgetHost(id)
	frame, err := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": id, "method": "host.log",
		"params": map[string]string{"level": level, "message": message},
	})
	if err != nil {
		return err
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case h.session.queue <- outgoing{frame: append(frame, '\n')}:
	default:
		return errors.New("protocol output queue is full")
	}
	select {
	case <-ctx.Done():
		return ctx.Err()
	case result := <-reply:
		return result.err
	}
}

func (s *session) forgetHost(id string) {
	s.mu.Lock()
	delete(s.hostPending, id)
	s.mu.Unlock()
}

func (s *session) deliverHostResponse(frame []byte) bool {
	var head struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      json.RawMessage `json:"id"`
		Method  string          `json:"method"`
		Result  json.RawMessage `json:"result"`
		Error   *Error          `json:"error"`
	}
	if json.Unmarshal(frame, &head) != nil || head.JSONRPC != "2.0" || head.Method != "" || len(head.ID) == 0 {
		return false
	}
	var id string
	if json.Unmarshal(head.ID, &id) != nil {
		return false
	}
	s.mu.Lock()
	reply := s.hostPending[id]
	s.mu.Unlock()
	if reply == nil {
		return false
	}
	var err error
	if head.Error != nil {
		err = head.Error
	} else if len(head.Result) == 0 || head.Result[0] != '{' {
		err = errors.New("host log response is not an object")
	}
	select {
	case reply <- hostCallResult{raw: head.Result, err: err}:
	default:
	}
	return true
}

func uintString(value uint64) string {
	if value == 0 {
		return "0"
	}
	var digits [20]byte
	index := len(digits)
	for value > 0 {
		index--
		digits[index] = byte('0' + value%10)
		value /= 10
	}
	return string(digits[index:])
}
