package terminal

import (
	"context"
	"time"
)

// maxBatchSessions 单次批量读允许的会话数上限：前端每个终端标签订阅一个
// 会话，标签数量直接对应这里的键数。
const maxBatchSessions = 32

// maxBatchBytes 单次批量读所有会话合计的原始字节预算：base64 后约 683KiB，
// 加 JSON 封装仍在宿主 1MiB 协议帧内，因此按本次键数摊分给各会话。
const maxBatchBytes = 512 * 1024

// minBatchBytes 摊分后的每会话下限：保证标签很多时每次仍能取走一段，
// 不至于因为帧预算被摊薄到几乎读不动。
const minBatchBytes = 4 * 1024

// BatchEvent 是批量读对单个会话的结果，字段与 terminal.read 一一对应。
type BatchEvent struct {
	SessionKey string
	Chunk      []byte
	EOF        bool
	ExitCode   int
	HasExit    bool
}

// ReadMulti 一次长轮询服务多个会话：任一会话有输出或已结束就立即返回它
// 们的事件，否则最多等 wait。前端所有终端标签共用这一条读取循环，避免
// 每个标签各占一个宿主桥并发额度（上限 8）而把输入写入挤成 too_many_requests。
//
// 会话不存在（已被 UI 关闭或摘除）时报 EOF，与 terminal.read 的收尾语义
// 一致，让调用方停止轮询该会话。
func (m *Manager) ReadMulti(ctx context.Context, keys []string, maxBytes int, wait time.Duration) ([]BatchEvent, error) {
	unique := dedupeKeys(keys)
	if len(unique) == 0 {
		return nil, nil
	}
	perKey := batchKeyBudget(maxBytes, len(unique))
	deadline := time.Now().Add(wait)
	for {
		// 先取信号通道再收集：期间到达的输出一定能让下面的 select 立即返回。
		changed := m.wakeChan()
		events, waiting := m.collectBatch(unique, perKey)
		if len(events) > 0 || waiting == 0 || wait <= 0 {
			return events, nil
		}
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return nil, nil
		}
		timer := time.NewTimer(remaining)
		select {
		case <-changed:
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
		timer.Stop()
	}
}

// collectBatch 取走每个会话当前可返回的事件：有数据给数据，已结束且取空
// 给 eof，两者都没有的会话计入 waiting 交由调用方继续等待。
func (m *Manager) collectBatch(keys []string, perKey int) (events []BatchEvent, waiting int) {
	events = make([]BatchEvent, 0, len(keys))
	for _, key := range keys {
		sess, ok := m.Get(key)
		if !ok {
			events = append(events, BatchEvent{SessionKey: key, EOF: true})
			continue
		}
		chunk, eof, exitCode, hasExit, _ := sess.take(perKey)
		if len(chunk) == 0 && !eof {
			waiting++
			continue
		}
		events = append(events, BatchEvent{SessionKey: key, Chunk: chunk, EOF: eof, ExitCode: exitCode, HasExit: hasExit})
	}
	return events, waiting
}

// batchKeyBudget 把本次合计字节预算摊到各会话，并尊重调用方的单会话上限。
func batchKeyBudget(maxBytes, sessions int) int {
	perKey := clampReadBytes(maxBytes)
	if sessions <= 0 {
		return perKey
	}
	shared := maxBatchBytes / sessions
	if shared < minBatchBytes {
		shared = minBatchBytes
	}
	if shared < perKey {
		perKey = shared
	}
	return perKey
}

// dedupeKeys 去重并保持调用方顺序，同时丢掉空键、限制键数上限。
func dedupeKeys(keys []string) []string {
	seen := make(map[string]struct{}, len(keys))
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		if key == "" {
			continue
		}
		if _, dup := seen[key]; dup {
			continue
		}
		seen[key] = struct{}{}
		out = append(out, key)
		if len(out) >= maxBatchSessions {
			break
		}
	}
	return out
}
