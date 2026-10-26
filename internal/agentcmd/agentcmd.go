// Package agentcmd 提供 Agent/自动化友好的 SSH 执行命令：单次执行、
// sudo 白名单执行、后台任务、主机指标与巡诊。所有命令走独立 session
// （非 PTY），与用户终端互不干扰。
package agentcmd

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/ssh"

	"gonavi-ssh/internal/settings"
	"gonavi-ssh/internal/sshclient"
)

const (
	defaultExecTimeout = 20 * time.Second
	maxOutputBytes     = 512 * 1024
	maxBgTasks         = 50
)

// Manager 管理后台任务表。
type Manager struct {
	settings *settings.Store

	mu    sync.Mutex
	tasks map[string]*BgTask
}

// BgTask 是一个后台执行任务：输出边运行边写入 taskBuffer，
// 查询按 offset 增量返回（运行中即有反馈）。
type BgTask struct {
	ID        string    `json:"id"`
	Command   string    `json:"command"`
	CreatedAt time.Time `json:"createdAt"`

	mu       sync.Mutex
	state    string // running | done | failed | cancelled
	output   *taskBuffer
	exitCode *int
	err      error
	cancel   context.CancelFunc
}

// taskBuffer 并发安全的限量输出缓冲：ssh 搬运 goroutine 写、
// TaskStatus 读，互不阻塞。
type taskBuffer struct {
	mu  sync.Mutex
	buf []byte
}

func (b *taskBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if len(b.buf)+len(p) > maxOutputBytes {
		remaining := maxOutputBytes - len(b.buf)
		if remaining > 0 {
			b.buf = append(b.buf, p[:remaining]...)
		}
		return len(p), nil // 静默丢弃超出部分
	}
	b.buf = append(b.buf, p...)
	return len(p), nil
}

func (b *taskBuffer) len() int {
	b.mu.Lock()
	defer b.mu.Unlock()
	return len(b.buf)
}

// slice 返回 [offset:] 的拷贝；offset 超界返回空。
func (b *taskBuffer) slice(offset int) []byte {
	b.mu.Lock()
	defer b.mu.Unlock()
	if offset < 0 || offset >= len(b.buf) {
		return nil
	}
	return append([]byte{}, b.buf[offset:]...)
}

func (t *BgTask) snapshot(offset int) map[string]any {
	t.mu.Lock()
	defer t.mu.Unlock()
	total := t.output.len()
	out := map[string]any{
		"taskId": t.ID, "command": t.Command, "state": t.state,
		"createdAt": t.CreatedAt, "totalBytes": total,
		"outputBase64": base64.StdEncoding.EncodeToString(t.output.slice(offset)),
	}
	if t.exitCode != nil {
		out["exitCode"] = *t.exitCode
		out["hasExit"] = true
	}
	if t.err != nil {
		out["error"] = t.err.Error()
	}
	return out
}

func NewManager(s *settings.Store) *Manager {
	return &Manager{settings: s, tasks: map[string]*BgTask{}}
}

// ExecResult 是一次同步执行的结果。
type ExecResult struct {
	OutputBase64 string `json:"outputBase64"`
	ExitCode     int    `json:"exitCode"`
	HasExit      bool   `json:"hasExit"`
	TimedOut     bool   `json:"timedOut"`
	Bytes        int    `json:"bytes"`
}

// Exec 在新 session 上同步执行命令（CombinedOutput），超时限制在
// 宿主 30s 调用期限之内。
func (m *Manager) Exec(ctx context.Context, conn *sshclient.Conn, command string, timeoutMillis int) (ExecResult, error) {
	if strings.TrimSpace(command) == "" {
		return ExecResult{}, fmt.Errorf("command is required")
	}
	timeout := defaultExecTimeout
	if timeoutMillis > 0 {
		timeout = time.Duration(timeoutMillis) * time.Millisecond
		if timeout > 25*time.Second {
			timeout = 25 * time.Second
		}
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	session, err := conn.Client().NewSession()
	if err != nil {
		return ExecResult{}, fmt.Errorf("open session: %w", err)
	}
	defer session.Close()

	var buf bytes.Buffer
	// stdout/stderr 必须共用同一个持锁 writer：x/crypto 用两个独立
	// goroutine 搬运，裸 bytes.Buffer 会数据竞争。
	limited := &limitedWriter{w: &buf}
	session.Stdout = limited
	session.Stderr = limited
	done := make(chan error, 1)
	go func() { done <- session.Run(command) }()
	select {
	case err := <-done:
		out := limited.snapshot()
		res := ExecResult{OutputBase64: base64.StdEncoding.EncodeToString(out), Bytes: len(out)}
		if err == nil {
			res.ExitCode, res.HasExit = 0, true
			return res, nil
		}
		if e, ok := err.(*ssh.ExitError); ok {
			res.ExitCode, res.HasExit = e.ExitStatus(), true
			return res, nil
		}
		return res, err
	case <-ctx.Done():
		_ = session.Close()
		// 关闭后 Run 很快返回；吸收它避免 goroutine 泄漏。
		go func() { <-done }()
		out := limited.snapshot()
		return ExecResult{
			OutputBase64: base64.StdEncoding.EncodeToString(out),
			Bytes:        len(out), TimedOut: true,
		}, nil
	}
}

// ExecSudo 执行白名单内的 sudo 命令。档案带有 Quick Sudo 密码时走
// `sudo -S` 从 stdin 注入密码（可附一次性动态码）；无密码则 `sudo -n`
// 依赖远端 NOPASSWD。
func (m *Manager) ExecSudo(ctx context.Context, conn *sshclient.Conn, sudoPassword, otpCode, command string, timeoutMillis int) (ExecResult, error) {
	if !m.settings.AllowedSudo(command) {
		return ExecResult{}, fmt.Errorf("command is not in the sudo allowlist")
	}
	if sudoPassword != "" {
		stdin := sudoPassword + "\n"
		if otpCode != "" {
			// 双因素 sudo（PAM TOTP）：密码后补第二行动态码。
			stdin += otpCode + "\n"
		}
		return m.execWithStdin(ctx, conn, "sudo -S -p '' "+command, stdin, timeoutMillis)
	}
	return m.Exec(ctx, conn, "sudo -n -p '' "+command, timeoutMillis)
}

// execWithStdin 执行命令并向其 stdin 预写数据（密码注入用）。
func (m *Manager) execWithStdin(ctx context.Context, conn *sshclient.Conn, command, stdinData string, timeoutMillis int) (ExecResult, error) {
	timeout := defaultExecTimeout
	if timeoutMillis > 0 {
		timeout = time.Duration(timeoutMillis) * time.Millisecond
		if timeout > 25*time.Second {
			timeout = 25 * time.Second
		}
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	session, err := conn.Client().NewSession()
	if err != nil {
		return ExecResult{}, fmt.Errorf("open session: %w", err)
	}
	defer session.Close()
	stdin, err := session.StdinPipe()
	if err != nil {
		return ExecResult{}, err
	}
	var buf bytes.Buffer
	limited := &limitedWriter{w: &buf}
	session.Stdout = limited
	session.Stderr = limited
	done := make(chan error, 1)
	go func() { done <- session.Run(command) }()
	// Run 已启动后再写 stdin：数据进管道缓冲，sudo 读取时即刻可用。
	_, _ = stdin.Write([]byte(stdinData))

	select {
	case err := <-done:
		_ = stdin.Close()
		out := limited.snapshot()
		res := ExecResult{OutputBase64: base64.StdEncoding.EncodeToString(out), Bytes: len(out)}
		if err == nil {
			res.ExitCode, res.HasExit = 0, true
			return res, nil
		}
		if e, ok := err.(*ssh.ExitError); ok {
			res.ExitCode, res.HasExit = e.ExitStatus(), true
			return res, nil
		}
		return res, err
	case <-ctx.Done():
		_ = session.Close()
		go func() { <-done }()
		out := limited.snapshot()
		return ExecResult{
			OutputBase64: base64.StdEncoding.EncodeToString(out),
			Bytes:        len(out), TimedOut: true,
		}, nil
	}
}

// RunBg 启动后台任务并立即返回任务 ID（适配宿主 30s 调用期限：
// 长命令不能同步等）。
func (m *Manager) RunBg(conn *sshclient.Conn, command string) (string, error) {
	if strings.TrimSpace(command) == "" {
		return "", fmt.Errorf("command is required")
	}
	id, err := newTaskID()
	if err != nil {
		return "", err
	}
	ctx, cancel := context.WithCancel(context.Background())
	task := &BgTask{ID: id, Command: command, CreatedAt: time.Now(), state: "running", cancel: cancel,
		output: &taskBuffer{}}

	m.mu.Lock()
	if len(m.tasks) >= maxBgTasks {
		// 淘汰最早结束的任务。
		var oldestID string
		var oldest time.Time
		for tid, t := range m.tasks {
			t.mu.Lock()
			st, created := t.state, t.CreatedAt
			t.mu.Unlock()
			if st != "running" && (oldestID == "" || created.Before(oldest)) {
				oldestID, oldest = tid, created
			}
		}
		if oldestID != "" {
			delete(m.tasks, oldestID)
		}
	}
	m.tasks[id] = task
	m.mu.Unlock()

	go func() {
		session, err := conn.Client().NewSession()
		if err != nil {
			task.mu.Lock()
			task.state, task.err = "failed", err
			task.mu.Unlock()
			return
		}
		defer session.Close()
		// 输出直写任务缓冲：运行中 TaskStatus 即可读到增量。
		session.Stdout = task.output
		session.Stderr = task.output
		done := make(chan error, 1)
		go func() {
			done <- session.Run(command)
		}()
		select {
		case err := <-done:
			task.mu.Lock()
			if e, ok := err.(*ssh.ExitError); ok {
				code := e.ExitStatus()
				task.exitCode = &code
				task.state = "done"
			} else if err == nil {
				code := 0
				task.exitCode = &code
				task.state = "done"
			} else {
				task.state, task.err = "failed", err
			}
			task.mu.Unlock()
		case <-ctx.Done():
			_ = session.Close()
			go func() { <-done }()
			task.mu.Lock()
			task.state = "cancelled"
			task.mu.Unlock()
		}
	}()
	return id, nil
}

// TaskStatus 按 offset 增量取任务输出。
func (m *Manager) TaskStatus(taskID string, offset int) (map[string]any, error) {
	m.mu.Lock()
	t, ok := m.tasks[taskID]
	m.mu.Unlock()
	if !ok {
		return nil, fmt.Errorf("task not found")
	}
	return t.snapshot(offset), nil
}

// TaskCancel 取消后台任务。
func (m *Manager) TaskCancel(taskID string) error {
	m.mu.Lock()
	t, ok := m.tasks[taskID]
	m.mu.Unlock()
	if !ok {
		return fmt.Errorf("task not found")
	}
	t.cancel()
	return nil
}

// HostResult 是 ExecMulti 单主机结果。
type HostResult struct {
	ConnectionID string `json:"connectionId"`
	Addr         string `json:"addr,omitempty"`
	OutputBase64 string `json:"outputBase64"`
	ExitCode     int    `json:"exitCode"`
	HasExit      bool   `json:"hasExit"`
	TimedOut     bool   `json:"timedOut"`
	Error        string `json:"error,omitempty"`
}

// ExecMulti 在多台主机上并行执行同一命令，结果按输入顺序返回。
// 每路超时上限 20s（并行总耗时不超宿主 30s 期限）。
func (m *Manager) ExecMulti(ctx context.Context, conns []*sshclient.Conn, command string, timeoutMillis int) []HostResult {
	if strings.TrimSpace(command) == "" {
		return nil
	}
	if len(conns) > 10 {
		conns = conns[:10]
	}
	results := make([]HostResult, len(conns))
	var wg sync.WaitGroup
	for i, conn := range conns {
		wg.Add(1)
		go func(i int, conn *sshclient.Conn) {
			defer wg.Done()
			res := HostResult{ConnectionID: conn.ID, Addr: conn.Addr}
			exec, err := m.Exec(ctx, conn, command, timeoutMillis)
			if err != nil {
				res.Error = err.Error()
			} else {
				res.OutputBase64 = exec.OutputBase64
				res.ExitCode, res.HasExit, res.TimedOut = exec.ExitCode, exec.HasExit, exec.TimedOut
			}
			results[i] = res
		}(i, conn)
	}
	wg.Wait()
	return results
}

// Metrics 采集主机概览：负载、内存、磁盘分区。尽力而为，命令缺失的
// 部分返回空。
func (m *Manager) Metrics(ctx context.Context, conn *sshclient.Conn) (map[string]any, error) {
	res, err := m.Exec(ctx, conn,
		`uptime; echo ---; free -b 2>/dev/null; echo ---; df -B1 -P 2>/dev/null | grep -v tmpfs`, 15000)
	if err != nil {
		return nil, err
	}
	out, _ := base64.StdEncoding.DecodeString(res.OutputBase64)
	sections := strings.SplitN(string(out), "---", 3)
	metrics := map[string]any{}
	if len(sections) > 0 {
		if load := parseLoad(strings.TrimSpace(sections[0])); load != nil {
			metrics["load"] = load
		}
	}
	if len(sections) > 1 {
		if mem := parseFreeMem(strings.TrimSpace(sections[1])); mem != nil {
			metrics["memory"] = mem
		}
	}
	if len(sections) > 2 {
		metrics["disks"] = parseDf(strings.TrimSpace(sections[2]))
	}
	metrics["uptimeText"] = strings.TrimSpace(strings.Join(strings.Fields(strings.TrimSpace(sections[0])), " "))
	return metrics, nil
}

// Triage 快速巡诊：磁盘占用、内存、dmesg 错误行。返回问题清单。
func (m *Manager) Triage(ctx context.Context, conn *sshclient.Conn) (map[string]any, error) {
	res, err := m.Exec(ctx, conn,
		`df -P 2>/dev/null | awk 'NR>1 && $5+0 > 85 {print $6" "$5" "$4}'; echo ---; free -m 2>/dev/null | awk '/^Mem:/ {print $2" "$3" "$7}'; echo ---; dmesg -l err 2>/dev/null | tail -5`, 15000)
	if err != nil {
		return nil, err
	}
	out, _ := base64.StdEncoding.DecodeString(res.OutputBase64)
	parts := strings.SplitN(string(out), "---", 3)
	issues := []string{}
	var disksHigh []string
	if len(parts) > 0 {
		for _, line := range strings.Split(strings.TrimSpace(parts[0]), "\n") {
			if strings.TrimSpace(line) != "" {
				disksHigh = append(disksHigh, strings.TrimSpace(line))
				issues = append(issues, "磁盘使用率超 85%: "+strings.TrimSpace(line))
			}
		}
	}
	memPart := ""
	if len(parts) > 1 {
		memPart = strings.TrimSpace(parts[1])
	}
	dmesgErrs := []string{}
	if len(parts) > 2 {
		for _, line := range strings.Split(strings.TrimSpace(parts[2]), "\n") {
			if strings.TrimSpace(line) != "" {
				dmesgErrs = append(dmesgErrs, strings.TrimSpace(line))
			}
		}
		issues = append(issues, fmt.Sprintf("dmesg 最近错误 %d 条（详见 errors 列表）", len(dmesgErrs)))
	}
	return map[string]any{
		"issues":     issues,
		"disksHigh":  disksHigh,
		"memSummary": memPart,
		"errors":     dmesgErrs,
	}, nil
}

// ---- 输出与解析 helpers ----

// limitedWriter 限制输出总量，防止失控命令撑爆内存。
type limitedWriter struct {
	w  *bytes.Buffer
	mu sync.Mutex
}

func (l *limitedWriter) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.w.Len()+len(p) > maxOutputBytes {
		remaining := maxOutputBytes - l.w.Len()
		if remaining > 0 {
			l.w.Write(p[:remaining])
		}
		return len(p), nil // 静默丢弃超出部分
	}
	return l.w.Write(p)
}

// snapshot 持锁拷贝当前输出，供调用方在 Run 尚未返回时安全读取。
func (l *limitedWriter) snapshot() []byte {
	l.mu.Lock()
	defer l.mu.Unlock()
	return append([]byte{}, l.w.Bytes()...)
}

func parseLoad(uptimeText string) []float64 {
	// 取 "load average: a, b, c" 部分。
	idx := strings.Index(uptimeText, "load average:")
	if idx < 0 {
		return nil
	}
	rest := strings.TrimPrefix(uptimeText[idx:], "load average:")
	fields := strings.FieldsFunc(rest, func(r rune) bool {
		return r == ',' || r == ' '
	})
	var out []float64
	for _, f := range fields {
		if v, err := strconv.ParseFloat(strings.TrimSpace(f), 64); err == nil {
			out = append(out, v)
			if len(out) == 3 {
				break
			}
		}
	}
	if len(out) != 3 {
		return nil
	}
	return out
}

func parseFreeMem(block string) map[string]int64 {
	lines := strings.Split(block, "\n")
	for _, line := range lines {
		fields := strings.Fields(line)
		if len(fields) >= 3 && fields[0] == "Mem:" {
			total, _ := strconv.ParseInt(fields[1], 10, 64)
			used, _ := strconv.ParseInt(fields[2], 10, 64)
			avail, _ := strconv.ParseInt(fields[len(fields)-1], 10, 64)
			return map[string]int64{"total": total, "used": used, "available": avail}
		}
	}
	return nil
}

type DiskRow struct {
	Mount      string `json:"mount"`
	TotalBytes int64  `json:"totalBytes"`
	UsedBytes  int64  `json:"usedBytes"`
	AvailBytes int64  `json:"availBytes"`
	UsePercent int    `json:"usePercent"`
}

func parseDf(block string) []DiskRow {
	var rows []DiskRow
	for _, line := range strings.Split(block, "\n") {
		fields := strings.Fields(line)
		if len(fields) < 6 || strings.HasPrefix(fields[0], "Filesystem") {
			continue
		}
		total, _ := strconv.ParseInt(fields[1], 10, 64)
		used, _ := strconv.ParseInt(fields[2], 10, 64)
		avail, _ := strconv.ParseInt(fields[3], 10, 64)
		pct, _ := strconv.Atoi(strings.TrimSuffix(fields[4], "%"))
		rows = append(rows, DiskRow{
			Mount: fields[5], TotalBytes: total, UsedBytes: used,
			AvailBytes: avail, UsePercent: pct,
		})
	}
	sort.Slice(rows, func(i, j int) bool { return rows[i].UsePercent > rows[j].UsePercent })
	return rows
}

func newTaskID() (string, error) {
	buf := make([]byte, 10)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return "bg_" + base64.RawURLEncoding.EncodeToString(buf), nil
}
