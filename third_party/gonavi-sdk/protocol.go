package plugin

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"unicode/utf8"
)

// DefaultMaxFrameBytes limits each newline-delimited JSON message to one MiB.
const DefaultMaxFrameBytes = 1 << 20

// Error is a JSON-RPC error safe to expose to the calling host.
type Error struct {
	Code    int             `json:"code"`
	Message string          `json:"message"`
	Data    json.RawMessage `json:"data,omitempty"`
}

// Error implements error without including potentially sensitive Data.
func (e *Error) Error() string { return e.Message }

type request struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type response struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *Error          `json:"error,omitempty"`
}

func parseRequest(frame []byte) (request, error) {
	var r request
	if !utf8.Valid(frame) || !json.Valid(frame) {
		return r, &Error{Code: -32700, Message: "invalid JSON"}
	}
	if err := json.Unmarshal(frame, &r); err != nil {
		return r, &Error{Code: -32600, Message: "invalid request"}
	}
	if r.JSONRPC != "2.0" || r.Method == "" {
		return r, &Error{Code: -32600, Message: "invalid request"}
	}
	if len(r.ID) != 0 && !validID(r.ID) {
		return r, &Error{Code: -32600, Message: "invalid request id"}
	}
	return r, nil
}

func validID(raw json.RawMessage) bool {
	var id any
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(&id); err != nil {
		return false
	}
	switch id.(type) {
	case string, json.Number:
		return true
	}
	return false
}

func requestKey(id json.RawMessage) string {
	var text string
	if json.Unmarshal(id, &text) == nil {
		return "s:" + text
	}
	return "n:" + string(bytes.TrimSpace(id))
}

func decodeParams(raw json.RawMessage, target any) error {
	if len(raw) == 0 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return &Error{Code: -32602, Message: "missing parameters"}
	}
	if err := json.Unmarshal(raw, target); err != nil {
		return &Error{Code: -32602, Message: "invalid parameters"}
	}
	return nil
}

func errorResponse(id json.RawMessage, err error) response {
	if !validID(id) {
		id = json.RawMessage("null")
	}
	rpcErr := &Error{Code: -32603, Message: "handler failed"}
	var supplied *Error
	if errors.As(err, &supplied) && supplied != nil {
		rpcErr = supplied
	}
	return response{JSONRPC: "2.0", ID: id, Error: rpcErr}
}

func encodeResponse(id json.RawMessage, value any, err error, limit int) ([]byte, error) {
	r := response{JSONRPC: "2.0", ID: id}
	if err != nil {
		r = errorResponse(id, err)
	} else {
		r.Result, err = json.Marshal(value)
		if err != nil {
			r = errorResponse(id, err)
		}
	}
	frame, err := json.Marshal(r)
	if err != nil {
		return nil, fmt.Errorf("encode response: %w", err)
	}
	if len(frame) > limit {
		frame, err = json.Marshal(errorResponse(id, &Error{Code: -32603, Message: "response exceeds frame limit"}))
		if err != nil {
			return nil, fmt.Errorf("encode frame limit error: %w", err)
		}
	}
	if len(frame) > limit {
		return nil, errors.New("response exceeds frame limit")
	}
	return append(frame, '\n'), nil
}

func writeFrame(writer io.Writer, frame []byte) error {
	for len(frame) > 0 {
		n, err := writer.Write(frame)
		if err != nil {
			return fmt.Errorf("write protocol frame: %w", err)
		}
		if n <= 0 || n > len(frame) {
			return io.ErrShortWrite
		}
		frame = frame[n:]
	}
	return nil
}
