// Package terminal 管理 PTY 会话：每条 SSH 连接可开多个终端会话，
// 会话输出进入内存缓冲，由 UI 以长轮询 terminal.read 拉取
// （GoNavi 插件协议没有插件→宿主推送通道，流式输出只能这样模拟）。
package terminal

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"regexp"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"gonavi-ssh/internal/sshclient"
)

// maxBuffered 输出缓冲上限：UI 长时间不来取时丢最旧数据，保进程不爆内存。
const maxBuffered = 1 << 20 // 1 MiB

// Session 是一个远端 PTY。
type Session struct {
	Key  string
	Conn *sshclient.Conn

	session *ssh.Session
	stdin   io.WriteCloser

	mu       sync.Mutex
	buf      []byte
	changed  chan struct{} // 新数据广播：close 后重置换新
	closed   bool
	exitCode *int // 远端 shell 正常退出时记录；用户关闭或异常断开为 nil
	deadAt   time.Time
	openedAt time.Time
	cols     int
	rows     int
	// onChange 由 Manager 注入：有新输出或会话结束时唤醒批量读（terminal.readMulti）。
	// 在锁外调用，只做一次非阻塞发信号。
	onChange func()

	// 命令行历史：从用户输入流里抽取可读行（跳过控制与转义序列）。
	lineBuf      []byte
	histEsc      int  // 转义序列状态：0 normal / 1 ESC / 2 CSI（跨 Write 延续）
	suppressNext bool // 上一行是敏感命令（sudo/su/mysql -p），下一行大概率是密码，不记录
	history      []string
	histMax      int
}

// sensitiveCmdRe 匹配后随密码输入的命令。输入流里看不到回显状态，
// 只能按命令形态保守跳过紧随其后的一行。
var sensitiveCmdRe = regexp.MustCompile(`(?i)^(sudo|su|passwd|chpasswd|ksu|mysqladmin|vncpasswd)\b|\bmysql\b[^|;&]*\s-p[\s$]|\bssh-keygen\b[^|;&]*\s-p[\s$]`)

// pushHistoryLocked 提交完整命令行进历史环；连续重复不重复记；
// 敏感命令的下一行（密码）不落历史。
func (s *Session) pushHistoryLocked(line string) {
	if s.histMax <= 0 {
		return // 历史功能被设置关闭
	}
	if s.suppressNext {
		s.suppressNext = false
		return
	}
	line = strings.TrimSpace(line)
	if line == "" {
		return
	}
	if sensitiveCmdRe.MatchString(line) {
		s.suppressNext = true
	}
	if len(s.history) > 0 && s.history[len(s.history)-1] == line {
		return
	}
	s.history = append(s.history, line)
	if len(s.history) > s.histMax {
		s.history = s.history[len(s.history)-s.histMax:]
	}
}

// frameSafeMax 单次返回给 UI 的原始字节上限：~700KiB base64 后约 933KiB，
// 加 JSON 封装仍在宿主 1MiB 协议帧内。
const frameSafeMax = 700 * 1024

// defaultReadBytes 请求缺省或越界时的每会话字节数。
const defaultReadBytes = 64 * 1024

// Read 长轮询读取输出：有数据立刻返回 maxBytes 内的一段；无数据时最多等
// wait；wait<=0 时不等待（缓冲空立即返回空）。ctx 取消（宿主
// $/cancelRequest）时立即返回。eof=true 表示会话已结束且缓冲已取空。
func (s *Session) Read(ctx context.Context, maxBytes int, wait time.Duration) (chunk []byte, eof bool, exitCode int, hasExit bool, err error) {
	maxBytes = clampReadBytes(maxBytes)
	deadline := time.Now().Add(wait)
	for {
		var changed <-chan struct{}
		chunk, eof, exitCode, hasExit, changed = s.take(maxBytes)
		if len(chunk) > 0 {
			return chunk, false, 0, false, nil
		}
		if eof {
			return nil, true, exitCode, hasExit, nil
		}
		// 缓冲空且会话未结束：等待新数据 / 截止 / 取消。
		if wait <= 0 {
			// 不等待：立即返回空，供调用方快速探测。
			return nil, false, 0, false, nil
		}
		timer := time.NewTimer(time.Until(deadline))
		select {
		case <-changed:
			// 有新数据或状态变化：回到取数再判一次。
		case <-ctx.Done():
			timer.Stop()
			return nil, false, 0, false, ctx.Err()
		case <-timer.C:
			// 等满 wait 仍无数据。这里必须返回：deadline 已过，
			// 再循环只会拿到立即触发的定时器空转。
			return nil, false, 0, false, nil
		}
		timer.Stop()
	}
}

// take 非阻塞取走缓冲的一段或结束标记（缓冲空且未结束时三者皆空），
// 并返回当前的变化信号供调用方悬挂等待。Read 与批量读共用它，保证
// 「有数据先给数据、取空后才报 eof」的语义只有一处实现。
func (s *Session) take(maxBytes int) (chunk []byte, eof bool, exitCode int, hasExit bool, changed <-chan struct{}) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if len(s.buf) > 0 {
		if len(s.buf) > maxBytes {
			chunk, s.buf = s.buf[:maxBytes], s.buf[maxBytes:]
		} else {
			chunk, s.buf = s.buf, nil
		}
		return chunk, false, 0, false, nil
	}
	if s.closed {
		code, ok := readExit(s.exitCode)
		return nil, true, code, ok, s.changed
	}
	return nil, false, 0, false, s.changed
}

func clampReadBytes(maxBytes int) int {
	if maxBytes <= 0 || maxBytes > frameSafeMax {
		return defaultReadBytes
	}
	return maxBytes
}

func readExit(code *int) (int, bool) {
	if code == nil {
		return 0, false
	}
	return *code, true
}

// Write 把用户输入（终端按键字节流）写入 PTY stdin，同时抽取命令行历史。
func (s *Session) Write(data []byte) (int, error) {
	s.mu.Lock()
	closed := s.closed
	s.extractHistoryLocked(data)
	s.mu.Unlock()
	if closed || s.stdin == nil {
		return 0, errors.New("session closed")
	}
	return s.stdin.Write(data)
}

// extractHistoryLocked 从输入流抽取命令行：可见字节积累，回车提交一行；
// CSI/ESC 转义序列整体跳过（方向键、功能键等不进历史）。转义状态跨调用
// 延续（s.histEsc），处理被拆开的序列。
func (s *Session) extractHistoryLocked(data []byte) {
	if s.histMax <= 0 {
		return
	}
	const (
		stNormal = 0
		stEsc    = 1 // 已见 ESC
		stCSI    = 2 // ESC [ 之后，吃参数直到终结符
	)
	for _, c := range data {
		switch s.histEsc {
		case stNormal:
			switch {
			case c == 0x1b:
				s.histEsc = stEsc
			case c == '\r' || c == '\n':
				s.pushHistoryLocked(string(s.lineBuf))
				s.lineBuf = s.lineBuf[:0]
			case c >= 0x20 && c != 0x7f:
				s.lineBuf = append(s.lineBuf, c)
			default:
				// 其他控制字符（退格等）：不进历史。
			}
		case stEsc:
			if c == '[' {
				s.histEsc = stCSI
			} else {
				s.histEsc = stNormal
			}
		case stCSI:
			// 终结符落在 0x40-0x7E（@A-Z ... ~）。
			if c >= 0x40 && c <= 0x7e {
				s.histEsc = stNormal
			}
		}
	}
}

// History 返回该会话的命令行历史（最近 limit 条，0 表示全部）。
func (s *Session) History(limit int) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	h := append([]string{}, s.history...)
	if limit > 0 && len(h) > limit {
		h = h[len(h)-limit:]
	}
	return h
}

// Resize 调整远端 PTY 窗口。
func (s *Session) Resize(cols, rows int) error {
	if cols <= 0 || rows <= 0 {
		return errors.New("invalid terminal size")
	}
	s.mu.Lock()
	closed := s.closed
	s.cols, s.rows = cols, rows
	s.mu.Unlock()
	if closed {
		return errors.New("session closed")
	}
	return s.session.WindowChange(rows, cols)
}

// Size 返回当前窗口尺寸。
func (s *Session) Size() (cols, rows int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cols, s.rows
}

// Close 结束会话。幂等；底层 ssh session 总是补一次 Close 兜底清理。
// session 为 nil 时（Open 中途失败或测试会话）只做状态收敛。
func (s *Session) Close() {
	s.mu.Lock()
	first := !s.closed
	s.closed = true
	if first {
		close(s.changed)
	}
	notify := s.onChange
	s.mu.Unlock()
	// 关闭即结束：唤醒批量读，让它拿到残留输出与 eof 并停止轮询本会话。
	if first && notify != nil {
		notify()
	}
	if s.session != nil {
		_ = s.session.Close()
	}
}

// appendOutput 由 stdout/stderr 泵 goroutine 调用。
// 会话已关闭时数据仍进缓冲（供亡会话回看），但不得再 close/换新
// changed——close 一个已关闭的 channel 会 panic，且泵 goroutine 不在
// SDK 的 recover 保护范围内。
func (s *Session) appendOutput(data []byte) {
	if len(data) == 0 {
		return
	}
	s.mu.Lock()
	s.buf = append(s.buf, data...)
	if len(s.buf) > maxBuffered {
		// 丢最旧：UI 迟到时宁可丢历史也不无限积压。
		s.buf = append([]byte{}, s.buf[len(s.buf)-maxBuffered:]...)
	}
	if !s.closed {
		close(s.changed)
		s.changed = make(chan struct{})
	}
	notify := s.onChange
	s.mu.Unlock()
	// 会话已关闭时数据仍进缓冲，批量读按缓冲唤醒才拿得到尾部输出。
	if notify != nil {
		notify()
	}
}

// markDead 由 Wait goroutine 调用：远端退出，记录退出码并唤醒等待者。
// 会话记录保留（亡会话可回看），由 UI 显式关闭时移除。
func (s *Session) markDead(exitCode *int) {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	s.exitCode = exitCode
	s.deadAt = time.Now()
	close(s.changed)
	notify := s.onChange
	s.mu.Unlock()
	if notify != nil {
		notify()
	}
}

// Manager 维护 sessionKey -> Session。会话远端退出后不自动摘除
// （保留尾部输出供 UI 回看），由 UI 关闭 tab 或 CloseAll 清理。
type Manager struct {
	mu        sync.Mutex
	sessions  map[string]*Session
	histLimit int
	// wake 汇总所有会话的输出/结束信号（关旧换新的广播通道）：批量读只
	// 悬挂在这一条通道上，不必为每个会话起等待 goroutine。
	wakeMu sync.Mutex
	wake   chan struct{}
}

func NewManager(historyLimit int) *Manager {
	if historyLimit <= 0 {
		historyLimit = 500
	}
	return &Manager{sessions: map[string]*Session{}, histLimit: historyLimit, wake: make(chan struct{})}
}

// SetHistory applies settings to live and future sessions. Disabling also erases
// partial input and previously recorded lines; enabling starts a fresh line.
func (m *Manager) SetHistory(enabled bool, limit int) {
	if !enabled {
		limit = 0
	} else if limit <= 0 {
		limit = 500
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	m.histLimit = limit
	for _, session := range m.sessions {
		session.mu.Lock()
		if session.histMax == 0 || limit == 0 {
			session.lineBuf = nil
			session.histEsc = 0
			session.suppressNext = false
		}
		session.histMax = limit
		if limit == 0 {
			session.history = nil
		} else if len(session.history) > limit {
			session.history = append([]string{}, session.history[len(session.history)-limit:]...)
		}
		session.mu.Unlock()
	}
}

// notify 广播唤醒：关闭当前信号通道并换新，所有等待者一起醒来。读方每轮
// 自己取空全部缓冲，密集输出只会多空转几轮，不会丢数据。
func (m *Manager) notify() {
	m.wakeMu.Lock()
	close(m.wake)
	m.wake = make(chan struct{})
	m.wakeMu.Unlock()
}

// wakeChan 返回当前信号通道。调用方必须先取通道再收集数据：反过来会漏掉
// 「取通道」与「收集」之间到达的输出（那时通道已经被换新了）。
func (m *Manager) wakeChan() <-chan struct{} {
	m.wakeMu.Lock()
	defer m.wakeMu.Unlock()
	return m.wake
}

// Open 在连接上开一个新的交互式 PTY 会话。
func (m *Manager) Open(ctx context.Context, conn *sshclient.Conn, cols, rows int) (*Session, error) {
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	var stdin io.WriteCloser
	var stdout, stderr io.Reader
	sshSession, err := conn.OpenSession(ctx, func(session *ssh.Session) error {
		modes := ssh.TerminalModes{ssh.ECHO: 1}
		if err := session.RequestPty("xterm-256color", rows, cols, modes); err != nil {
			return fmt.Errorf("request pty: %w", err)
		}
		var err error
		if stdin, err = session.StdinPipe(); err != nil {
			return err
		}
		if stdout, err = session.StdoutPipe(); err != nil {
			return err
		}
		if stderr, err = session.StderrPipe(); err != nil {
			return err
		}
		if err := session.Shell(); err != nil {
			return fmt.Errorf("start shell: %w", err)
		}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("open ssh session: %w", err)
	}

	key, err := newSessionKey()
	if err != nil {
		_ = sshSession.Close()
		return nil, err
	}
	sess := &Session{
		Key: key, Conn: conn, session: sshSession, stdin: stdin,
		openedAt: time.Now(), cols: cols, rows: rows,
		changed: make(chan struct{}), onChange: m.notify,
	}

	// stdout/stderr 合流进同一缓冲（终端语义下两者交织渲染）。
	go func() { _, _ = io.Copy(pumpWriter{sess}, stdout) }()
	go func() { _, _ = io.Copy(pumpWriter{sess}, stderr) }()
	go func() {
		werr := sshSession.Wait()
		code := exitCodeFrom(werr)
		sess.markDead(code)
	}()

	m.mu.Lock()
	sess.histMax = m.histLimit
	m.sessions[key] = sess
	m.mu.Unlock()
	return sess, nil
}

// pumpWriter 让 io.Copy 直接喂 Session 缓冲。
type pumpWriter struct{ s *Session }

func (w pumpWriter) Write(p []byte) (int, error) {
	w.s.appendOutput(p)
	return len(p), nil
}

func exitCodeFrom(err error) *int {
	var exitErr *ssh.ExitError
	if errors.As(err, &exitErr) {
		code := exitErr.ExitStatus()
		return &code
	}
	// 用户主动关闭或网络断开：无退出码。
	return nil
}

// Get 按 key 查会话。
func (m *Manager) Get(key string) (*Session, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s, ok := m.sessions[key]
	return s, ok
}

// List 返回会话概要；connID 非空时按连接过滤。
func (m *Manager) List(connID string) []StatusEntry {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]StatusEntry, 0, len(m.sessions))
	for _, s := range m.sessions {
		if connID != "" && s.Conn.ID != connID {
			continue
		}
		s.mu.Lock()
		out = append(out, StatusEntry{
			SessionKey: s.Key, ConnectionID: s.Conn.ID, Alive: !s.closed,
			Cols: s.cols, Rows: s.rows, OpenedAt: s.openedAt,
			BufferedBytes: len(s.buf),
		})
		s.mu.Unlock()
	}
	return out
}

// StatusEntry 是会话对外状态（无敏感信息）。
type StatusEntry struct {
	SessionKey    string    `json:"sessionKey"`
	ConnectionID  string    `json:"connectionId"`
	Alive         bool      `json:"alive"`
	Cols          int       `json:"cols"`
	Rows          int       `json:"rows"`
	OpenedAt      time.Time `json:"openedAt"`
	BufferedBytes int       `json:"bufferedBytes"`
}

// Remove 摘除会话记录（不关底层 PTY）；不存在时静默。
func (m *Manager) Remove(key string) {
	m.mu.Lock()
	_, existed := m.sessions[key]
	delete(m.sessions, key)
	m.mu.Unlock()
	if existed {
		// 摘除也是状态变化：唤醒批量读，让它对消失的会话报 eof 收尾。
		m.notify()
	}
}

// CloseByKey 关闭并摘除指定会话；不存在不是错误。
func (m *Manager) CloseByKey(key string) {
	m.mu.Lock()
	s, ok := m.sessions[key]
	delete(m.sessions, key)
	m.mu.Unlock()
	if ok {
		s.Close()
		// Close 只在首次关闭时发信号，已亡会话的摘除由这里补一次唤醒。
		m.notify()
	}
}

// CloseAll 关闭全部会话，进程退出前清理用。
func (m *Manager) CloseAll() {
	m.mu.Lock()
	sessions := make([]*Session, 0, len(m.sessions))
	for _, s := range m.sessions {
		sessions = append(sessions, s)
	}
	m.sessions = map[string]*Session{}
	m.mu.Unlock()
	if len(sessions) > 0 {
		m.notify()
	}
	for _, s := range sessions {
		s.Close()
	}
}

func newSessionKey() (string, error) {
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return "t_" + base64.RawURLEncoding.EncodeToString(buf), nil
}
