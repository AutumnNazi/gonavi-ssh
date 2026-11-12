package plugin

import (
	"bytes"
	"context"
	"encoding/json"
)

func (s *session) deliverLifecycle(ctx context.Context, params json.RawMessage) {
	event, generation, ok := parseLifecycle(params)
	if !ok || s.options.OnLifecycle == nil {
		return
	}
	go func() {
		defer func() { _ = recover() }()
		s.options.OnLifecycle(withHost(ctx, s), event, generation)
	}()
}

func parseLifecycle(params json.RawMessage) (string, uint64, bool) {
	decoder := json.NewDecoder(bytes.NewReader(params))
	decoder.UseNumber()
	var raw map[string]any
	if decoder.Decode(&raw) != nil || len(raw) != 2 {
		return "", 0, false
	}
	event, _ := raw["event"].(string)
	number, _ := raw["generation"].(json.Number)
	value, err := number.Int64()
	if event != "running" || err != nil || value <= 0 {
		return "", 0, false
	}
	return event, uint64(value), true
}
