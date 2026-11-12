package plugin

import (
	"encoding/json"
	"unicode/utf8"
)

func validateAIProviderCalls(calls []AIProviderToolCall, offered map[string]bool) error {
	if len(calls) > 64 {
		return aiProviderFailure("limit_exceeded")
	}
	ids := make(map[string]bool, len(calls))
	for _, call := range calls {
		if call.Type != "function" || !aiProviderText(call.ID, 128, true) || ids[call.ID] || !aiProviderText(call.Function.Name, 128, true) || (offered != nil && !offered[call.Function.Name]) || !utf8.ValidString(call.Function.Arguments) {
			return aiProviderFailure("generation_failed")
		}
		raw := []byte(call.Function.Arguments)
		if len(raw) > 32<<10 {
			return aiProviderFailure("limit_exceeded")
		}
		if !aiProviderJSONObject(raw, 32<<10) {
			return aiProviderFailure("generation_failed")
		}
		ids[call.ID] = true
	}
	encoded, err := json.Marshal(calls)
	if err != nil {
		return aiProviderFailure("generation_failed")
	}
	if len(encoded) > aiProviderMaxToolBytes {
		return aiProviderFailure("limit_exceeded")
	}
	return nil
}

func validateAIProviderCompletion(value AIProviderCompletion, offered map[string]bool, supportsTools bool) error {
	switch value.FinishReason {
	case "stop", "tool_calls", "length":
	default:
		return aiProviderFailure("generation_failed")
	}
	if (!supportsTools && len(value.ToolCalls) > 0) || (value.FinishReason == "tool_calls" && len(value.ToolCalls) == 0) || (len(value.ToolCalls) > 0 && value.FinishReason != "tool_calls" && value.FinishReason != "length") {
		return aiProviderFailure("generation_failed")
	}
	if err := validateAIProviderCalls(value.ToolCalls, offered); err != nil {
		return err
	}
	if value.Usage != nil {
		usage := value.Usage
		values := []int64{usage.PromptTokens, usage.CompletionTokens, usage.TotalTokens}
		if usage.CachedTokens != nil {
			values = append(values, *usage.CachedTokens)
		}
		for _, count := range values {
			if count < 0 || count > 9007199254740991 {
				return aiProviderFailure("generation_failed")
			}
		}
	}
	return nil
}
