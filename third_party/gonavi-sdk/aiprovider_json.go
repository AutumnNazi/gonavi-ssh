package plugin

import (
	"bytes"
	"encoding/json"
	"io"
	"unicode/utf8"
)

func strictAIProviderJSON(raw []byte, limit int) error {
	if len(raw) > limit {
		return aiProviderFailure("limit_exceeded")
	}
	if !utf8.Valid(raw) {
		return aiProviderFailure("invalid_request")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	nodes := 0
	if err := scanAIProviderJSON(decoder, 0, &nodes); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return aiProviderFailure("invalid_request")
	}
	return nil
}

func scanAIProviderJSON(decoder *json.Decoder, depth int, nodes *int) error {
	*nodes++
	if depth > 32 || *nodes > 32768 {
		return aiProviderFailure("limit_exceeded")
	}
	token, err := decoder.Token()
	if err != nil {
		return aiProviderFailure("invalid_request")
	}
	switch token {
	case json.Delim('{'):
		keys := make(map[string]bool)
		for decoder.More() {
			key, err := decoder.Token()
			if err != nil {
				return aiProviderFailure("invalid_request")
			}
			text, ok := key.(string)
			if !ok || keys[text] {
				return aiProviderFailure("invalid_request")
			}
			keys[text] = true
			*nodes++
			if *nodes > 32768 {
				return aiProviderFailure("limit_exceeded")
			}
			if err = scanAIProviderJSON(decoder, depth+1, nodes); err != nil {
				return err
			}
		}
		if end, err := decoder.Token(); err != nil || end != json.Delim('}') {
			return aiProviderFailure("invalid_request")
		}
	case json.Delim('['):
		for decoder.More() {
			if err := scanAIProviderJSON(decoder, depth+1, nodes); err != nil {
				return err
			}
		}
		if end, err := decoder.Token(); err != nil || end != json.Delim(']') {
			return aiProviderFailure("invalid_request")
		}
	default:
		if _, delimiter := token.(json.Delim); delimiter {
			return aiProviderFailure("invalid_request")
		}
	}
	return nil
}

func decodeAIProviderObject(raw json.RawMessage, target any, keys ...string) error {
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil || object == nil {
		return aiProviderFailure("invalid_request")
	}
	allowed := make(map[string]bool, len(keys))
	for _, key := range keys {
		allowed[key] = true
	}
	for key, value := range object {
		if !allowed[key] || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return aiProviderFailure("invalid_request")
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(target) != nil {
		return aiProviderFailure("invalid_request")
	}
	return nil
}

func aiProviderJSONObject(raw json.RawMessage, limit int) bool {
	raw = bytes.TrimSpace(raw)
	if len(raw) == 0 || raw[0] != '{' {
		return false
	}
	return strictAIProviderJSON(raw, limit) == nil
}
