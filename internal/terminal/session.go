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

// Read 长轮询读取输出：有数据立刻返回 maxBytes 内的一段；无数据时最多等
// wait；wait<=0 时不等待（缓冲空立即返回空）。ctx 取消（宿主
// $/cancelRequest）时立即返回。eof=true 表示会话已结束且缓冲已取空。
// maxBytes 上限按 base64 编码后不超协议帧预算（1MiB）反推。
func (s *Session) Read(ctx context.Context, maxBytes int, wait time.Duration) (chunk []byte, eof bool, exitCode int, hasExit bool, err error) {
	// ~700KiB 原始字节 base64 后约 933KiB，加 JSON 封装仍在 1MiB 帧内。
	const frameSafeMax = 700 * 1024
	if maxBytes <= 0 || maxBytes > frameSafeMax {
		maxBytes = 64 * 1024
	}
	deadline := time.Now().Add(wait)
	for {
		s.mu.Lock()
		if len(s.buf) > 0 {
			if len(s.buf) > maxBytes {
				chunk, s.buf = s.buf[:maxBytes], s.buf[maxBytes:]
			} else {
				chunk, s.buf = s.buf, nil
			}
			s.mu.Unlock()
			return chunk, false, 0, false, nil
		}
		if s.closed {
			exitCode, hasExit := readExit(s.exitCode)
			s.mu.Unlock()
			return nil, true, exitCode, hasExit, nil
		}
		changed := s.changed
		s.mu.Unlock()

		// 缓冲空且会话未结束：等待新数据 / 截止 / 取消。
		var timer <-chan time.Time
		if wait > 0 {
			t := time.NewTimer(time.Until(deadline))
			timer = t.C
			defer t.Stop()
		} else {
			// 不等待：立即返回空，供调用方快速探测。
			return nil, false, 0, false, nil
		}
		select {
		case <-changed:
		case <-ctx.Done():
			return nil, false, 0, false, ctx.Err()
		case <-timer:
			return nil, false, 0, false, nil
		}
	}
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
	s.mu.Unlock()
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
	s.mu.Unlock()
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
	s.mu.Unlock()
}

// Manager 维护 sessionKey -> Session。会话远端退出后不自动摘除
// （保留尾部输出供 UI 回看），由 UI 关闭 tab 或 CloseAll 清理。
type Manager struct {
	mu        sync.Mutex
	sessions  map[string]*Session
	histLimit int
}

func NewManager(historyLimit int) *Manager {
	if historyLimit <= 0 {
		historyLimit = 500
	}
	return &Manager{sessions: map[string]*Session{}, histLimit: historyLimit}
}

// Open 在连接上开一个新的交互式 PTY 会话。
func (m *Manager) Open(conn *sshclient.Conn, cols, rows int) (*Session, error) {
	if cols <= 0 {
		cols = 80
	}
	if rows <= 0 {
		rows = 24
	}
	sshSession, err := conn.Client().NewSession()
	if err != nil {
		return nil, fmt.Errorf("open ssh session: %w", err)
	}
	// xterm-256color 与前端 xterm.js 的 TERM 匹配；回显、行编辑、
	// Ctrl+C 等终端行为全部交给远端 pty 处理。
	modes := ssh.TerminalModes{ssh.ECHO: 1}
	if err := sshSession.RequestPty("xterm-256color", rows, cols, modes); err != nil {
		_ = sshSession.Close()
		return nil, fmt.Errorf("request pty: %w", err)
	}
	stdin, err := sshSession.StdinPipe()
	if err != nil {
		_ = sshSession.Close()
		return nil, err
	}
	stdout, err := sshSession.StdoutPipe()
	if err != nil {
		_ = sshSession.Close()
		return nil, err
	}
	stderr, err := sshSession.StderrPipe()
	if err != nil {
		_ = sshSession.Close()
		return nil, err
	}
	if err := sshSession.Shell(); err != nil {
		_ = sshSession.Close()
		return nil, fmt.Errorf("start shell: %w", err)
	}

	key, err := newSessionKey()
	if err != nil {
		_ = sshSession.Close()
		return nil, err
	}
	sess := &Session{
		Key: key, Conn: conn, session: sshSession, stdin: stdin,
		openedAt: time.Now(), cols: cols, rows: rows,
		changed: make(chan struct{}), histMax: m.histLimit,
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
	delete(m.sessions, key)
	m.mu.Unlock()
}

// CloseByKey 关闭并摘除指定会话；不存在不是错误。
func (m *Manager) CloseByKey(key string) {
	m.mu.Lock()
	s, ok := m.sessions[key]
	delete(m.sessions, key)
	m.mu.Unlock()
	if ok {
		s.Close()
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
