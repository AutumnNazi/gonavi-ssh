package plugin

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"strconv"
	"unicode/utf8"
)

type exportJSONBudget struct{ nodes int }

func scanExporterJSON(ctx context.Context, raw []byte, depth int, budget *exportJSONBudget) error {
	if !utf8.Valid(raw) || !exporterUnicodeEscapes(raw) {
		return exporterError("invalid_request")
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := scanExporterValue(ctx, decoder, depth, budget); err != nil {
		return err
	}
	if _, err := decoder.Token(); err != io.EOF {
		return exporterError("invalid_request")
	}
	return nil
}

func scanExporterValue(ctx context.Context, decoder *json.Decoder, depth int, budget *exportJSONBudget) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	budget.nodes++
	if depth > 32 || budget.nodes > 131072 {
		return exporterError("limit_exceeded")
	}
	token, err := decoder.Token()
	if err != nil {
		return exporterError("invalid_request")
	}
	switch token {
	case json.Delim('{'):
		keys := make(map[string]bool)
		for decoder.More() {
			key, err := decoder.Token()
			if err != nil {
				return exporterError("invalid_request")
			}
			name, ok := key.(string)
			if !ok || keys[name] {
				return exporterError("invalid_request")
			}
			keys[name] = true
			if err = scanExporterValue(ctx, decoder, depth+1, budget); err != nil {
				return err
			}
		}
		if end, err := decoder.Token(); err != nil || end != json.Delim('}') {
			return exporterError("invalid_request")
		}
	case json.Delim('['):
		for decoder.More() {
			if err := scanExporterValue(ctx, decoder, depth+1, budget); err != nil {
				return err
			}
		}
		if end, err := decoder.Token(); err != nil || end != json.Delim(']') {
			return exporterError("invalid_request")
		}
	default:
		if _, delimiter := token.(json.Delim); delimiter {
			return exporterError("invalid_request")
		}
	}
	return nil
}

func exporterUnicodeEscapes(raw []byte) bool {
	quoted := false
	for index := 0; index < len(raw); index++ {
		if raw[index] == '"' {
			quoted = !quoted
			continue
		}
		if !quoted || raw[index] != '\\' {
			continue
		}
		index++
		if index >= len(raw) {
			return false
		}
		if raw[index] != 'u' {
			continue
		}
		if index+4 >= len(raw) {
			return false
		}
		value, err := strconv.ParseUint(string(raw[index+1:index+5]), 16, 16)
		if err != nil {
			return false
		}
		index += 4
		if value >= 0xdc00 && value <= 0xdfff {
			return false
		}
		if value < 0xd800 || value > 0xdbff {
			continue
		}
		if index+6 >= len(raw) || raw[index+1] != '\\' || raw[index+2] != 'u' {
			return false
		}
		low, err := strconv.ParseUint(string(raw[index+3:index+7]), 16, 16)
		if err != nil || low < 0xdc00 || low > 0xdfff {
			return false
		}
		index += 6
	}
	return !quoted
}

func exporterObjectOptional(raw json.RawMessage, required, optional []string) (map[string]json.RawMessage, error) {
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil || object == nil || len(object) < len(required) || len(object) > len(required)+len(optional) {
		return nil, exporterError("invalid_request")
	}
	allowed := make(map[string]bool, len(required)+len(optional))
	for _, name := range required {
		value, ok := object[name]
		if !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return nil, exporterError("invalid_request")
		}
		allowed[name] = true
	}
	for _, name := range optional {
		if value, ok := object[name]; ok {
			if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
				return nil, exporterError("invalid_request")
			}
			allowed[name] = true
		}
	}
	for name := range object {
		if !allowed[name] {
			return nil, exporterError("invalid_request")
		}
	}
	return object, nil
}

func exporterObject(raw json.RawMessage, required ...string) (map[string]json.RawMessage, error) {
	var object map[string]json.RawMessage
	if json.Unmarshal(raw, &object) != nil || object == nil || len(object) != len(required) {
		return nil, exporterError("invalid_request")
	}
	for _, name := range required {
		value, ok := object[name]
		if !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return nil, exporterError("invalid_request")
		}
	}
	return object, nil
}
