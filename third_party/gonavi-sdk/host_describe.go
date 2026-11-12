package plugin

import (
	"context"
	"encoding/json"
	"errors"
)

// HostIdentity is the live caller binding, not a value supplied by the plugin.
type HostIdentity struct {
	PluginID    string `json:"pluginId"`
	Generation  uint64 `json:"generation"`
	HostVersion string `json:"hostVersion"`
	Locale      string `json:"locale"`
}

// Describe asks the host for this process identity. Params cannot select another plugin.
func (h *Host) Describe(ctx context.Context) (HostIdentity, error) {
	var identity HostIdentity
	raw, err := h.callHost(ctx, "host.describe", map[string]any{})
	if err != nil {
		return identity, err
	}
	if json.Unmarshal(raw, &identity) != nil || identity.PluginID == "" || identity.Generation == 0 {
		return HostIdentity{}, errors.New("host describe response is incomplete")
	}
	return identity, nil
}

func (h *Host) callHost(ctx context.Context, method string, params any) (json.RawMessage, error) {
	if h == nil || h.session == nil || ctx == nil {
		return nil, errors.New("host call is unavailable")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
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
	frame, err := json.Marshal(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params})
	if err != nil {
		return nil, err
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case h.session.queue <- outgoing{frame: append(frame, '\n')}:
	default:
		return nil, errors.New("protocol output queue is full")
	}
	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case result := <-reply:
		return result.raw, result.err
	}
}
