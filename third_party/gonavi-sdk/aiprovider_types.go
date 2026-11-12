package plugin

import (
	"context"
	"encoding/json"
	"time"
)

// AIProviderConfig contains only the selected provider's projected settings. Never log it.
type AIProviderConfig struct {
	BaseURL string            `json:"baseUrl"`
	APIKey  string            `json:"apiKey"`
	Model   string            `json:"model"`
	Headers map[string]string `json:"headers,omitempty"`
}

// AIProviderToolCall is one complete tool invocation, never an arguments fragment.
type AIProviderToolCall struct {
	ID       string                     `json:"id"`
	Type     string                     `json:"type"`
	Function AIProviderToolCallFunction `json:"function"`
}

// AIProviderToolCallFunction carries a complete JSON object encoded as a string.
type AIProviderToolCallFunction struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// AIProviderTool describes an offered function without granting permission to execute it.
type AIProviderTool struct {
	Type     string                 `json:"type"`
	Function AIProviderToolFunction `json:"function"`
}

// AIProviderToolFunction uses a bounded object JSON Schema for parameters.
type AIProviderToolFunction struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Parameters  json.RawMessage `json:"parameters"`
}

// AIProviderMessage mirrors the host message shape. Images are bounded base64 data
// URLs that only appear on user messages and only when the provider declares them.
type AIProviderMessage struct {
	Role             string               `json:"role"`
	Content          string               `json:"content"`
	ReasoningContent string               `json:"reasoning_content,omitempty"`
	ToolCallID       string               `json:"tool_call_id,omitempty"`
	ToolCalls        []AIProviderToolCall `json:"tool_calls,omitempty"`
	Images           []string             `json:"images,omitempty"`
}

// AIProviderRequest is one stateless model turn. Zero MaxTokens selects the declared output cap.
type AIProviderRequest struct {
	Messages    []AIProviderMessage `json:"messages"`
	Temperature float64             `json:"temperature"`
	MaxTokens   int                 `json:"maxTokens"`
	Tools       []AIProviderTool    `json:"tools,omitempty"`
}

// AIProviderStart is a private copy of one provider-bound admitted request.
type AIProviderStart struct {
	ProviderID string            `json:"providerId"`
	RequestID  string            `json:"requestId"`
	Config     AIProviderConfig  `json:"config"`
	Request    AIProviderRequest `json:"request"`
}

// AIProviderDelta carries incremental text only; the dispatcher assigns event sequence numbers.
type AIProviderDelta struct {
	Content          string `json:"content,omitempty"`
	ReasoningContent string `json:"reasoningContent,omitempty"`
}

// AIProviderUsage uses safe nonnegative integer counts; nil usage means unavailable, not zero.
type AIProviderUsage struct {
	PromptTokens     int64  `json:"promptTokens"`
	CompletionTokens int64  `json:"completionTokens"`
	TotalTokens      int64  `json:"totalTokens"`
	CachedTokens     *int64 `json:"cachedTokens,omitempty"`
}

// AIProviderCompletion is exactly one terminal snapshot. Tools must be complete and offered in the request.
type AIProviderCompletion struct {
	FinishReason string               `json:"finishReason"`
	ToolCalls    []AIProviderToolCall `json:"toolCalls,omitempty"`
	Usage        *AIProviderUsage     `json:"usage,omitempty"`
}

// AIProviderEvent is the bounded pull wire event. Fields not belonging to its type are absent.
type AIProviderEvent struct {
	Sequence         uint64               `json:"sequence"`
	Type             string               `json:"type"`
	Content          string               `json:"content,omitempty"`
	ReasoningContent string               `json:"reasoningContent,omitempty"`
	FinishReason     string               `json:"finishReason,omitempty"`
	ToolCalls        []AIProviderToolCall `json:"toolCalls,omitempty"`
	Usage            *AIProviderUsage     `json:"usage,omitempty"`
	Code             string               `json:"code,omitempty"`
}

// AIProviderEmit applies cancellable backpressure. Do not retain it or launch unjoined producer work.
type AIProviderEmit func(AIProviderDelta) error

// AIProviderGenerate runs on a dispatcher-root child context, never the short-lived start RPC context.
type AIProviderGenerate func(context.Context, AIProviderStart, AIProviderEmit) (AIProviderCompletion, error)

// AIProviderRegistration is copied into one dispatcher; registrations are not a global registry.
type AIProviderRegistration struct {
	Models         []AIModel
	SupportsTools  bool
	SupportsImages bool
	Generate       AIProviderGenerate
}

// AIProviderLimits can lower, but never raise, v1 safety budgets. Zero selects defaults.
type AIProviderLimits struct {
	MaxWorkers       int
	MaxSessions      int
	QueueEvents      int
	QueueBytes       int
	CompletionBytes  int
	CompletionEvents int
	Tombstones       int
	Duration         time.Duration
	PullWait         time.Duration
	CloseWait        time.Duration
	IdleLease        time.Duration
}

// AIProviderOptions contains up to eight provider-local handlers sharing one bounded worker pool.
type AIProviderOptions struct {
	Providers map[string]AIProviderRegistration
	Limits    AIProviderLimits
}

// AIProviderBatch owns immutable encoded event snapshots; callers should treat its slice as read-only.
type AIProviderBatch struct {
	Events []json.RawMessage `json:"events"`
}
