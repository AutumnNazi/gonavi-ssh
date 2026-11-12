package plugin

import (
	"context"
	"encoding/json"
	"strings"
	"time"
	"unicode/utf8"
)

func (d *AIProviderDispatcher) emit(session *aiProviderSession, delta AIProviderDelta) error {
	if (delta.Content == "" && delta.ReasoningContent == "") || !utf8.ValidString(delta.Content) || !utf8.ValidString(delta.ReasoningContent) || strings.ContainsRune(delta.Content, 0) || strings.ContainsRune(delta.ReasoningContent, 0) {
		d.mu.Lock()
		d.failLocked(session, "generation_failed")
		d.mu.Unlock()
		return aiProviderFailure("generation_failed")
	}
	for {
		d.mu.Lock()
		if session.closed || session.terminal || session.ctx.Err() != nil {
			d.mu.Unlock()
			return aiProviderFailure("canceled")
		}
		event := AIProviderEvent{Sequence: session.sequence + 1, Type: "delta", Content: delta.Content, ReasoningContent: delta.ReasoningContent}
		raw, err := json.Marshal(event)
		if err != nil || len(raw) > aiProviderMaxEventBytes || session.totalBytes+len(raw) > d.limits.CompletionBytes-aiProviderMaxEventBytes || session.sequence >= uint64(d.limits.CompletionEvents-1) {
			d.failLocked(session, "limit_exceeded")
			d.mu.Unlock()
			return aiProviderFailure("limit_exceeded")
		}
		// Reserve one event and 64KiB so an error/done terminal never discards already accepted deltas.
		if len(session.queue) < d.limits.QueueEvents-1 && session.queueBytes+len(raw) <= d.limits.QueueBytes-aiProviderMaxEventBytes {
			session.sequence++
			session.totalBytes += len(raw)
			session.queueBytes += len(raw)
			session.queue = append(session.queue, aiProviderQueuedEvent{raw: raw})
			d.notifyLocked(session)
			d.mu.Unlock()
			return nil
		}
		changed := session.changed
		d.mu.Unlock()
		select {
		case <-session.ctx.Done():
			return session.ctx.Err()
		case <-changed:
		}
	}
}

func (d *AIProviderDispatcher) failLocked(session *aiProviderSession, code string) {
	if session.closed || session.terminal {
		return
	}
	d.terminalLocked(session, AIProviderEvent{Type: "error", Code: safeAIProviderCode(code)})
	session.cancel()
}

func (d *AIProviderDispatcher) terminalLocked(session *aiProviderSession, event AIProviderEvent) {
	if session.closed || session.terminal {
		return
	}
	event.Sequence = session.sequence + 1
	raw, err := json.Marshal(event)
	if err != nil || len(raw) > aiProviderMaxEventBytes || session.totalBytes+len(raw) > d.limits.CompletionBytes || session.sequence >= uint64(d.limits.CompletionEvents) {
		event = AIProviderEvent{Sequence: session.sequence + 1, Type: "error", Code: "limit_exceeded"}
		raw, err = json.Marshal(event)
		if err != nil {
			d.removeLocked(session, "generation_failed")
			return
		}
	}
	session.sequence++
	session.totalBytes += len(raw)
	session.queueBytes += len(raw)
	session.terminal = true
	session.queue = append(session.queue, aiProviderQueuedEvent{raw: raw, terminal: true})
	d.notifyLocked(session)
}

func (d *AIProviderDispatcher) pull(ctx context.Context, key string) (any, error) {
	d.mu.Lock()
	session := d.sessions[key]
	if session == nil {
		reason := d.tombstones[key]
		d.mu.Unlock()
		if reason == "" {
			reason = "invalid_request"
		}
		return nil, aiProviderRPCError(reason)
	}
	if session.pulling {
		d.mu.Unlock()
		return nil, aiProviderRPCError("invalid_request")
	}
	session.pulling = true
	session.lastPull = time.Now()
	session.idleTimer.Reset(d.limits.IdleLease)
	d.mu.Unlock()
	defer func() { d.mu.Lock(); session.pulling = false; d.mu.Unlock() }()
	timer := time.NewTimer(d.limits.PullWait)
	defer timer.Stop()
	for {
		d.mu.Lock()
		if err := ctx.Err(); err != nil {
			d.mu.Unlock()
			return nil, err
		}
		if session.closed {
			reason := session.reason
			d.mu.Unlock()
			return nil, aiProviderRPCError(reason)
		}
		if len(session.queue) > 0 {
			result := d.drainLocked(session)
			d.mu.Unlock()
			return result, nil
		}
		changed := session.changed
		d.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-timer.C:
			d.mu.Lock()
			if err := ctx.Err(); err != nil {
				d.mu.Unlock()
				return nil, err
			}
			if session.closed {
				reason := session.reason
				d.mu.Unlock()
				return nil, aiProviderRPCError(reason)
			}
			if len(session.queue) > 0 {
				result := d.drainLocked(session)
				d.mu.Unlock()
				return result, nil
			}
			d.mu.Unlock()
			return AIProviderBatch{Events: []json.RawMessage{}}, nil
		case <-changed:
		}
	}
}

func (d *AIProviderDispatcher) drainLocked(session *aiProviderSession) AIProviderBatch {
	batch := AIProviderBatch{Events: make([]json.RawMessage, 0, aiProviderMaxBatchEvents)}
	size := len(`{"events":[]}`)
	count := 0
	terminal := false
	for _, event := range session.queue {
		extra := len(event.raw)
		if count > 0 {
			extra++
		}
		if count == aiProviderMaxBatchEvents || size+extra > aiProviderMaxBatchBytes {
			break
		}
		batch.Events = append(batch.Events, event.raw)
		size += extra
		count++
		session.queueBytes -= len(event.raw)
		if event.terminal {
			terminal = true
			break
		}
	}
	for index := 0; index < count; index++ {
		session.queue[index] = aiProviderQueuedEvent{}
	}
	session.queue = session.queue[count:]
	if terminal {
		d.removeLocked(session, "invalid_request")
	} else {
		d.notifyLocked(session)
	}
	return batch
}
