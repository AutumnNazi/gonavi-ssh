package plugin

import (
	"context"
	"errors"
	"time"
)

const (
	aiProviderMaxRequestBytes = 512 << 10
	aiProviderMaxEventBytes   = 64 << 10
	aiProviderMaxBatchBytes   = 128 << 10
	aiProviderMaxBatchEvents  = 16
	aiProviderMaxToolBytes    = 48 << 10
)

// AIProviderFailure carries only a fixed safe wire code. Arbitrary error messages are never forwarded.
type AIProviderFailure struct{ Code string }

// Error omits arbitrary upstream errors, URLs, headers and request data.
func (e *AIProviderFailure) Error() string {
	return "AI provider generation failed: " + safeAIProviderCode(e.Code)
}

func safeAIProviderCode(code string) string {
	switch code {
	case "canceled", "deadline", "unsupported", "invalid_request", "generation_failed", "limit_exceeded":
		return code
	}
	return "generation_failed"
}

func aiProviderFailure(code string) error { return &AIProviderFailure{Code: safeAIProviderCode(code)} }
func aiProviderRPCError(code string) error {
	return &Error{Code: -32010, Message: safeAIProviderCode(code)}
}

func aiProviderErrorCode(ctx context.Context, err error) string {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return "deadline"
	}
	if ctx.Err() != nil {
		return "canceled"
	}
	var failure *AIProviderFailure
	if errors.As(err, &failure) && failure != nil {
		return safeAIProviderCode(failure.Code)
	}
	return "generation_failed"
}

func normalizeAIProviderLimits(limits AIProviderLimits) (AIProviderLimits, error) {
	ints := []struct {
		value            *int
		minimum, maximum int
	}{
		{&limits.MaxWorkers, 1, 16}, {&limits.MaxSessions, 1, 16}, {&limits.QueueEvents, 2, 64},
		{&limits.QueueBytes, 2 * aiProviderMaxEventBytes, 512 << 10},
		{&limits.CompletionBytes, 2 * aiProviderMaxEventBytes, 8 << 20},
		{&limits.CompletionEvents, 1, 65536}, {&limits.Tombstones, 1, 4096},
	}
	for _, bound := range ints {
		if *bound.value == 0 {
			*bound.value = bound.maximum
		}
		if *bound.value < bound.minimum || *bound.value > bound.maximum {
			return limits, aiProviderFailure("invalid_request")
		}
	}
	durations := []struct {
		value   *time.Duration
		maximum time.Duration
	}{
		{&limits.Duration, 5 * time.Minute}, {&limits.PullWait, time.Second}, {&limits.CloseWait, 2 * time.Second}, {&limits.IdleLease, 30 * time.Second},
	}
	for _, bound := range durations {
		if *bound.value == 0 {
			*bound.value = bound.maximum
		}
		if *bound.value <= 0 || *bound.value > bound.maximum {
			return limits, aiProviderFailure("invalid_request")
		}
	}
	return limits, nil
}
