package terminal

import (
	"context"
	"testing"
	"time"
)

// newTestSession 构造不依赖真实 SSH 的会话，只测缓冲与长轮询语义。
func newTestSession() *Session {
	return &Session{
		Key: "t_test", changed: make(chan struct{}),
		openedAt: time.Now(), cols: 80, rows: 24,
	}
}

// Read 在等待期被新数据唤醒并取走数据。
func TestReadWakesOnOutput(t *testing.T) {
	s := newTestSession()
	go func() {
		time.Sleep(30 * time.Millisecond)
		s.appendOutput([]byte("hello pty"))
	}()
	start := time.Now()
	chunk, eof, _, _, err := s.Read(context.Background(), 1024, 2*time.Second)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if eof {
		t.Fatal("unexpected eof")
	}
	if string(chunk) != "hello pty" {
		t.Fatalf("chunk=%q", chunk)
	}
	if time.Since(start) > time.Second {
		t.Fatal("read did not wake on new output promptly")
	}
}

// 无数据时 Read 等满 wait 后返回空。
func TestReadTimesOut(t *testing.T) {
	s := newTestSession()
	chunk, eof, _, _, err := s.Read(context.Background(), 1024, 60*time.Millisecond)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if len(chunk) != 0 || eof {
		t.Fatalf("expected empty non-eof result, chunk=%q eof=%v", chunk, eof)
	}
}

// ctx 取消必须立刻中断等待（对应宿主 $/cancelRequest）。
func TestReadHonorsCancel(t *testing.T) {
	s := newTestSession()
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		time.Sleep(30 * time.Millisecond)
		cancel()
	}()
	_, _, _, _, err := s.Read(ctx, 1024, 5*time.Second)
	if err == nil {
		t.Fatal("expected context error")
	}
}

// 会话结束后：先吐空缓冲，再返回 eof 与退出码。
func TestReadEofAndExit(t *testing.T) {
	s := newTestSession()
	code := 7
	s.appendOutput([]byte("tail"))
	s.markDead(&code)

	chunk, eof, _, _, err := s.Read(context.Background(), 1024, 0)
	if err != nil || string(chunk) != "tail" || eof {
		t.Fatalf("first read should drain buffer: chunk=%q eof=%v err=%v", chunk, eof, err)
	}
	_, eof, gotCode, hasExit, err := s.Read(context.Background(), 1024, 0)
	if err != nil || !eof || !hasExit || gotCode != 7 {
		t.Fatalf("second read should report eof+exit: eof=%v hasExit=%v code=%d err=%v", eof, hasExit, gotCode, err)
	}
}

// maxBytes 截断：一次只取走一段，剩余留给下一次。
func TestReadTruncatesToMaxBytes(t *testing.T) {
	s := newTestSession()
	s.appendOutput([]byte("0123456789"))
	first, _, _, _, _ := s.Read(context.Background(), 4, 0)
	second, _, _, _, _ := s.Read(context.Background(), 1024, 0)
	if string(first) != "0123" {
		t.Fatalf("first=%q", first)
	}
	if string(second) != "456789" {
		t.Fatalf("second=%q", second)
	}
}

// 缓冲超限时丢最旧数据，进程内存有界。
func TestBufferDropsOldest(t *testing.T) {
	s := newTestSession()
	s.appendOutput(make([]byte, maxBuffered+2048))
	s.mu.Lock()
	size := len(s.buf)
	s.mu.Unlock()
	if size != maxBuffered {
		t.Fatalf("buffer size=%d want %d", size, maxBuffered)
	}
}

// markDead 幂等：重复调用不得 panic（changed channel 只关一次）。
func TestMarkDeadIdempotent(t *testing.T) {
	s := newTestSession()
	code := 0
	s.markDead(&code)
	s.markDead(&code)
	s.Close()
	s.Close()
}

// Write 抽取命令行历史：可见字符成行，控制序列不进历史，连续重复去重。
func TestWriteExtractsHistory(t *testing.T) {
	s := newTestSession()
	s.histMax = 10

	_, _ = s.Write([]byte("\x1b[Als\x1b[D -la\r"))
	_, _ = s.Write([]byte("du -sh /var\r"))
	_, _ = s.Write([]byte("du -sh /var\r")) // 重复不记
	_, _ = s.Write([]byte("\r"))            // 空行不记

	h := s.History(0)
	want := []string{"ls -la", "du -sh /var"}
	if len(h) != len(want) {
		t.Fatalf("history %q", h)
	}
	for i := range want {
		if h[i] != want[i] {
			t.Fatalf("history[%d]=%q want %q", i, h[i], want[i])
		}
	}
}

// 会话关闭后泵 goroutine 再写输出不得 panic（changed channel 已关）。
func TestAppendOutputAfterCloseNoPanic(t *testing.T) {
	s := newTestSession()
	s.markDead(nil)
	s.appendOutput([]byte("late output"))
	s.appendOutput([]byte("more"))
	// 数据仍可回看。
	chunk, eof, _, _, err := s.Read(context.Background(), 1024, 0)
	if err != nil || eof || string(chunk) != "late outputmore" {
		t.Fatalf("chunk=%q eof=%v err=%v", chunk, eof, err)
	}
}

// wait<=0 且缓冲空：立即返回空，不阻塞。
func TestReadNoWaitImmediateReturn(t *testing.T) {
	s := newTestSession()
	done := make(chan struct{})
	go func() {
		_, _, _, _, _ = s.Read(context.Background(), 1024, 0)
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("read with wait<=0 must return immediately")
	}
}

// maxBytes 超帧预算时收紧，避免 base64 后超 1MiB 响应帧。
func TestReadMaxBytesFrameBudget(t *testing.T) {
	s := newTestSession()
	s.appendOutput(make([]byte, 1024*1024)) // 1MiB 原始
	chunk, _, _, _, _ := s.Read(context.Background(), 5*1024*1024, 0)
	if len(chunk) > 700*1024 {
		t.Fatalf("chunk %d exceeds frame-safe budget", len(chunk))
	}
}

// sudo 后的密码行不进历史。
func TestHistorySuppressesPasswordLine(t *testing.T) {
	s := newTestSession()
	s.histMax = 10
	_, _ = s.Write([]byte("sudo systemctl restart nginx\r"))
	_, _ = s.Write([]byte("my-secret-password\r"))
	_, _ = s.Write([]byte("uptime\r"))
	h := s.History(0)
	if len(h) != 2 || h[0] != "sudo systemctl restart nginx" || h[1] != "uptime" {
		t.Fatalf("history %q", h)
	}
}
