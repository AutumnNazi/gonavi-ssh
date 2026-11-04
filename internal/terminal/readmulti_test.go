package terminal

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"
)

// newBatchSession 造一个已挂进管理器的测试会话：onChange 指向 m.notify，
// 与 Open 的真实装配一致，批量读的唤醒路径才真的被覆盖。
func newBatchSession(m *Manager, key string) *Session {
	s := &Session{
		Key: key, changed: make(chan struct{}),
		openedAt: time.Now(), cols: 80, rows: 24, onChange: m.notify,
	}
	m.mu.Lock()
	m.sessions[key] = s
	m.mu.Unlock()
	return s
}

func eventByKey(events []BatchEvent, key string) (BatchEvent, bool) {
	for _, ev := range events {
		if ev.SessionKey == key {
			return ev, true
		}
	}
	return BatchEvent{}, false
}

// 一次调用取回所有已有输出的会话，空闲会话不占事件位。
func TestReadMultiReturnsEverySessionWithData(t *testing.T) {
	m := NewManager(0)
	a := newBatchSession(m, "t_a")
	b := newBatchSession(m, "t_b")
	newBatchSession(m, "t_idle")
	a.appendOutput([]byte("alpha"))
	b.appendOutput([]byte("beta"))

	events, err := m.ReadMulti(context.Background(), []string{"t_a", "t_idle", "t_b"}, 1024, time.Second)
	if err != nil {
		t.Fatalf("read multi: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("events=%d want 2: %+v", len(events), events)
	}
	first, ok := eventByKey(events, "t_a")
	if !ok || string(first.Chunk) != "alpha" {
		t.Fatalf("t_a event=%+v ok=%v", first, ok)
	}
	second, ok := eventByKey(events, "t_b")
	if !ok || string(second.Chunk) != "beta" {
		t.Fatalf("t_b event=%+v ok=%v", second, ok)
	}
	if _, ok := eventByKey(events, "t_idle"); ok {
		t.Fatal("idle session must not produce an event")
	}
}

// 无数据时挂起等待，任一会话产出即被唤醒返回。
func TestReadMultiWakesOnOutput(t *testing.T) {
	m := NewManager(0)
	a := newBatchSession(m, "t_a")
	newBatchSession(m, "t_b")
	go func() {
		time.Sleep(30 * time.Millisecond)
		a.appendOutput([]byte("wake"))
	}()

	start := time.Now()
	events, err := m.ReadMulti(context.Background(), []string{"t_a", "t_b"}, 1024, 3*time.Second)
	if err != nil {
		t.Fatalf("read multi: %v", err)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("did not wake promptly: %v", elapsed)
	}
	ev, ok := eventByKey(events, "t_a")
	if !ok || string(ev.Chunk) != "wake" {
		t.Fatalf("events=%+v", events)
	}
}

// 关闭的会话报 eof 并带退出码；不存在的键同样报 eof，让调用方停止轮询。
func TestReadMultiReportsEofForClosedAndRemovedSessions(t *testing.T) {
	m := NewManager(0)
	dead := newBatchSession(m, "t_dead")
	code := 7
	dead.markDead(&code)

	events, err := m.ReadMulti(context.Background(), []string{"t_dead", "t_gone"}, 1024, time.Second)
	if err != nil {
		t.Fatalf("read multi: %v", err)
	}
	if len(events) != 2 {
		t.Fatalf("events=%d want 2: %+v", len(events), events)
	}
	deadEvent, _ := eventByKey(events, "t_dead")
	if !deadEvent.EOF || !deadEvent.HasExit || deadEvent.ExitCode != 7 {
		t.Fatalf("dead event=%+v", deadEvent)
	}
	goneEvent, _ := eventByKey(events, "t_gone")
	if !goneEvent.EOF || goneEvent.HasExit {
		t.Fatalf("gone event=%+v", goneEvent)
	}
}

// 结束会话的残留输出先于 eof 给出，取空后才报结束。
func TestReadMultiDrainsTailBeforeEof(t *testing.T) {
	m := NewManager(0)
	s := newBatchSession(m, "t_tail")
	s.appendOutput([]byte("tail"))
	s.markDead(nil)

	events, err := m.ReadMulti(context.Background(), []string{"t_tail"}, 1024, time.Second)
	if err != nil {
		t.Fatalf("read multi: %v", err)
	}
	if len(events) != 1 || string(events[0].Chunk) != "tail" || events[0].EOF {
		t.Fatalf("events=%+v", events)
	}
	events, err = m.ReadMulti(context.Background(), []string{"t_tail"}, 1024, time.Second)
	if err != nil {
		t.Fatalf("read multi: %v", err)
	}
	if len(events) != 1 || !events[0].EOF {
		t.Fatalf("second read events=%+v", events)
	}
}

// 全空闲时最多等满 wait 后返回空事件，不提前返回也不超时。
func TestReadMultiReturnsEmptyAfterWait(t *testing.T) {
	m := NewManager(0)
	newBatchSession(m, "t_a")

	start := time.Now()
	events, err := m.ReadMulti(context.Background(), []string{"t_a"}, 1024, 60*time.Millisecond)
	if err != nil {
		t.Fatalf("read multi: %v", err)
	}
	if len(events) != 0 {
		t.Fatalf("events=%+v", events)
	}
	if elapsed := time.Since(start); elapsed < 50*time.Millisecond {
		t.Fatalf("returned before the wait elapsed: %v", elapsed)
	}
}

// wait<=0 立即返回，供调用方快速探测。
func TestReadMultiWithoutWaitReturnsImmediately(t *testing.T) {
	m := NewManager(0)
	newBatchSession(m, "t_a")
	start := time.Now()
	events, err := m.ReadMulti(context.Background(), []string{"t_a"}, 1024, 0)
	if err != nil || len(events) != 0 {
		t.Fatalf("events=%+v err=%v", events, err)
	}
	if elapsed := time.Since(start); elapsed > 200*time.Millisecond {
		t.Fatalf("did not return immediately: %v", elapsed)
	}
}

// 等待期间宿主取消调用：立即返回 ctx 错误，不拖到超时。
func TestReadMultiStopsOnContextCancel(t *testing.T) {
	m := NewManager(0)
	newBatchSession(m, "t_a")
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(30 * time.Millisecond)
		cancel()
	}()
	start := time.Now()
	_, err := m.ReadMulti(ctx, []string{"t_a"}, 1024, 3*time.Second)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err=%v want context.Canceled", err)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("did not stop on cancel: %v", elapsed)
	}
}

// 帧预算按会话摊分：多会话同时有大输出时，单次返回总量不超批预算，
// 每个会话都能拿到均分额度而不是让第一个吃掉全部。
func TestReadMultiSharesFrameBudgetAcrossSessions(t *testing.T) {
	m := NewManager(0)
	keys := []string{"t_1", "t_2", "t_3", "t_4"}
	for _, key := range keys {
		s := newBatchSession(m, key)
		s.appendOutput(bytes.Repeat([]byte("x"), 200*1024))
	}

	events, err := m.ReadMulti(context.Background(), keys, frameSafeMax, time.Second)
	if err != nil {
		t.Fatalf("read multi: %v", err)
	}
	if len(events) != len(keys) {
		t.Fatalf("events=%d want %d", len(events), len(keys))
	}
	wantPerKey := maxBatchBytes / len(keys)
	total := 0
	for _, ev := range events {
		if len(ev.Chunk) != wantPerKey {
			t.Fatalf("session %s chunk=%d want %d", ev.SessionKey, len(ev.Chunk), wantPerKey)
		}
		total += len(ev.Chunk)
	}
	if total > maxBatchBytes {
		t.Fatalf("batch total=%d exceeds budget %d", total, maxBatchBytes)
	}
}

// 会话少时不给预算打折：单个会话仍可取满调用方给的上限。
func TestReadMultiSingleSessionKeepsRequestedBudget(t *testing.T) {
	m := NewManager(0)
	s := newBatchSession(m, "t_a")
	s.appendOutput(bytes.Repeat([]byte("y"), 200*1024))

	events, err := m.ReadMulti(context.Background(), []string{"t_a"}, 200*1024, time.Second)
	if err != nil {
		t.Fatalf("read multi: %v", err)
	}
	if len(events) != 1 || len(events[0].Chunk) != 200*1024 {
		t.Fatalf("events=%+v", events)
	}
}

// 重复键只读一次，避免同一会话在一次调用里被取两段。
func TestReadMultiDedupesKeys(t *testing.T) {
	m := NewManager(0)
	s := newBatchSession(m, "t_a")
	s.appendOutput([]byte("once"))

	events, err := m.ReadMulti(context.Background(), []string{"t_a", "t_a", ""}, 1024, time.Second)
	if err != nil {
		t.Fatalf("read multi: %v", err)
	}
	if len(events) != 1 || string(events[0].Chunk) != "once" {
		t.Fatalf("events=%+v", events)
	}
}

// 没有可用键时不阻塞也不报错。
func TestReadMultiEmptyKeys(t *testing.T) {
	m := NewManager(0)
	events, err := m.ReadMulti(context.Background(), []string{"", ""}, 1024, time.Second)
	if err != nil || len(events) != 0 {
		t.Fatalf("events=%+v err=%v", events, err)
	}
}

// 摘除会话要唤醒挂起的批量读，否则轮询要等满超时才收尾。
func TestReadMultiWakesWhenSessionRemoved(t *testing.T) {
	m := NewManager(0)
	newBatchSession(m, "t_a")
	go func() {
		time.Sleep(30 * time.Millisecond)
		m.Remove("t_a")
	}()

	start := time.Now()
	events, err := m.ReadMulti(context.Background(), []string{"t_a"}, 1024, 3*time.Second)
	if err != nil {
		t.Fatalf("read multi: %v", err)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("did not wake on removal: %v", elapsed)
	}
	if len(events) != 1 || !events[0].EOF {
		t.Fatalf("events=%+v", events)
	}
}
