package plugin

import (
	"bytes"
	"encoding/json"
	"math"
	"net/url"
	"regexp"
	"strings"
	"unicode/utf8"
)

var aiProviderLocalID = regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,63}$`)
var aiProviderRequestID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)
var aiProviderModelID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:/@+-]{0,127}$`)
var aiProviderHeaderName = regexp.MustCompile("^[!#$%&'*+.^_" + "`" + "|~0-9A-Za-z-]+$")

type aiProviderEnvelope struct {
	ProtocolVersion int             `json:"protocolVersion"`
	Operation       string          `json:"operation"`
	ProviderID      string          `json:"providerId"`
	RequestID       string          `json:"requestId"`
	Config          json.RawMessage `json:"config,omitempty"`
	Request         json.RawMessage `json:"request,omitempty"`
}

func parseAIProviderEnvelope(raw json.RawMessage) (aiProviderEnvelope, error) {
	var envelope aiProviderEnvelope
	// The widest admitted frame covers a bounded image start; text-only requests
	// are narrowed back to aiProviderMaxRequestBytes after decoding.
	if err := strictAIProviderJSON(raw, aiProviderMaxImageRequestBytes); err != nil {
		return envelope, err
	}
	if err := decodeAIProviderObject(raw, &envelope, "protocolVersion", "operation", "providerId", "requestId", "config", "request"); err != nil {
		return envelope, err
	}
	if envelope.ProtocolVersion != 1 || !aiProviderLocalID.MatchString(envelope.ProviderID) || !aiProviderRequestID.MatchString(envelope.RequestID) {
		return envelope, aiProviderFailure("invalid_request")
	}
	switch envelope.Operation {
	case "start":
		if len(envelope.Config) == 0 || len(envelope.Request) == 0 {
			return envelope, aiProviderFailure("invalid_request")
		}
	case "pull", "cancel":
		if len(envelope.Config) != 0 || len(envelope.Request) != 0 {
			return envelope, aiProviderFailure("invalid_request")
		}
	default:
		return envelope, aiProviderFailure("unsupported")
	}
	return envelope, nil
}

func validateAIProviderRegistration(value AIProviderRegistration) (AIProviderRegistration, error) {
	if value.Generate == nil || len(value.Models) == 0 || len(value.Models) > 32 {
		return value, aiProviderFailure("invalid_request")
	}
	value.Models = append([]AIModel(nil), value.Models...)
	ids := make(map[string]bool, len(value.Models))
	for _, model := range value.Models {
		if !aiProviderModelID.MatchString(model.ID) || ids[model.ID] || !aiProviderText(model.Name, 256, true) || model.ContextWindow < 1024 || model.ContextWindow > 262144 || model.MaxOutputTokens < 1 || model.MaxOutputTokens > 65536 || model.MaxOutputTokens > model.ContextWindow {
			return value, aiProviderFailure("invalid_request")
		}
		ids[model.ID] = true
	}
	return value, nil
}

func validateAIProviderStart(envelope aiProviderEnvelope, registration AIProviderRegistration) (AIProviderStart, map[string]bool, error) {
	start := AIProviderStart{ProviderID: envelope.ProviderID, RequestID: envelope.RequestID}
	if err := decodeAIProviderObject(envelope.Config, &start.Config, "baseUrl", "apiKey", "model", "headers"); err != nil {
		return start, nil, err
	}
	if err := validateAIProviderConfig(start.Config); err != nil {
		return start, nil, err
	}
	cap := 0
	for _, model := range registration.Models {
		if model.ID == start.Config.Model {
			cap = model.MaxOutputTokens
		}
	}
	if cap == 0 {
		return start, nil, aiProviderFailure("invalid_request")
	}
	if err := decodeAIProviderObject(envelope.Request, &start.Request, "messages", "temperature", "maxTokens", "tools"); err != nil {
		return start, nil, err
	}
	if len(start.Request.Messages) == 0 || len(start.Request.Messages) > 512 || len(start.Request.Tools) > 128 || math.IsNaN(start.Request.Temperature) || math.IsInf(start.Request.Temperature, 0) || start.Request.Temperature < 0 || start.Request.Temperature > 2 || start.Request.MaxTokens < 0 || start.Request.MaxTokens > cap {
		return start, nil, aiProviderFailure("invalid_request")
	}
	if start.Request.MaxTokens == 0 {
		start.Request.MaxTokens = cap
	}
	offered := make(map[string]bool, len(start.Request.Tools))
	if !registration.SupportsTools && len(start.Request.Tools) > 0 {
		return start, nil, aiProviderFailure("unsupported")
	}
	for _, tool := range start.Request.Tools {
		if tool.Type != "function" || !aiProviderText(tool.Function.Name, 128, true) || offered[tool.Function.Name] || !aiProviderText(tool.Function.Description, aiProviderMaxRequestBytes, false) || !aiProviderJSONObject(bytes.TrimSpace(tool.Function.Parameters), aiProviderMaxRequestBytes) {
			return start, nil, aiProviderFailure("invalid_request")
		}
		offered[tool.Function.Name] = true
	}
	var object map[string]json.RawMessage
	if json.Unmarshal(envelope.Request, &object) != nil {
		return start, nil, aiProviderFailure("invalid_request")
	}
	var messages []json.RawMessage
	if json.Unmarshal(object["messages"], &messages) != nil {
		return start, nil, aiProviderFailure("invalid_request")
	}
	for index, raw := range messages {
		message := &start.Request.Messages[index]
		if err := decodeAIProviderObject(raw, message, "role", "content", "reasoning_content", "tool_call_id", "tool_calls", "images"); err != nil {
			return start, nil, err
		}
		var fields map[string]json.RawMessage
		if json.Unmarshal(raw, &fields) != nil {
			return start, nil, aiProviderFailure("invalid_request")
		}
		if value, ok := fields["images"]; ok {
			var images []string
			if json.Unmarshal(value, &images) != nil || len(images) == 0 {
				return start, nil, aiProviderFailure("invalid_request")
			}
		}
		switch message.Role {
		case "system", "user", "assistant", "tool":
		default:
			return start, nil, aiProviderFailure("invalid_request")
		}
		if !utf8.ValidString(message.Content) || !utf8.ValidString(message.ReasoningContent) || strings.ContainsRune(message.Content, 0) || strings.ContainsRune(message.ReasoningContent, 0) || (message.Role == "tool" && !aiProviderText(message.ToolCallID, 128, true)) || (message.ToolCallID != "" && !aiProviderText(message.ToolCallID, 128, true)) {
			return start, nil, aiProviderFailure("invalid_request")
		}
		if len(message.ToolCalls) > 0 {
			if message.Role != "assistant" {
				return start, nil, aiProviderFailure("invalid_request")
			}
			if err := validateAIProviderCalls(message.ToolCalls, nil); err != nil {
				return start, nil, err
			}
		}
	}
	if err := validateAIProviderImages(start.Request.Messages, registration.SupportsImages); err != nil {
		return start, nil, err
	}
	requestLimit := aiProviderMaxRequestBytes
	if aiProviderRequestHasImages(start.Request) {
		requestLimit = aiProviderMaxImageRequestBytes
	}
	if len(envelope.Request) > requestLimit {
		return start, nil, aiProviderFailure("limit_exceeded")
	}
	return start, offered, nil
}

func aiProviderText(value string, limit int, required bool) bool {
	return len(value) <= limit && utf8.ValidString(value) && !strings.ContainsRune(value, 0) && (!required || strings.TrimSpace(value) != "")
}

func validateAIProviderConfig(config AIProviderConfig) error {
	if len(config.BaseURL) > 4096 || !aiProviderText(config.BaseURL, 4096, false) || !aiProviderText(config.APIKey, 16<<10, false) || !aiProviderModelID.MatchString(config.Model) {
		return aiProviderFailure("invalid_request")
	}
	if config.BaseURL != "" {
		parsed, err := url.Parse(config.BaseURL)
		if err != nil || parsed.Host == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil || parsed.Opaque != "" {
			return aiProviderFailure("invalid_request")
		}
	}
	if len(config.Headers) > 32 {
		return aiProviderFailure("invalid_request")
	}
	seen := make(map[string]bool, len(config.Headers))
	total := 0
	for name, value := range config.Headers {
		lower := strings.ToLower(name)
		total += len(name) + len(value)
		if len(name) > 128 || !aiProviderHeaderName.MatchString(name) || seen[lower] || !aiProviderText(value, 4096, false) || strings.ContainsAny(value, "\r\n") || total > 16<<10 {
			return aiProviderFailure("invalid_request")
		}
		switch lower {
		case "host", "content-length", "connection", "transfer-encoding", "upgrade", "proxy-authorization":
			return aiProviderFailure("invalid_request")
		}
		seen[lower] = true
	}
	return nil
}
