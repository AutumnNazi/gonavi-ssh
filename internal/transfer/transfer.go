// Package transfer 管理文件传输任务：上传/下载均在插件进程内直接
// SFTP↔本地磁盘进行，桥上只传路径与任务句柄。上传走远端临时文件 +
// 原子改名；下载走本地 .part 临时文件，完成后原子替换，重开任务时
// 从已完成字节断点续传。
package transfer

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"sync"
	"time"

	"gonavi-ssh/internal/sftpops"
	"gonavi-ssh/internal/sshclient"
)

// Direction 传输方向。
type Direction string

const (
	Upload         Direction = "upload"         // 本地 → 远端
	Download       Direction = "download"       // 远端 → 本地
	ServerToServer Direction = "serverToServer" // 远端 A → 远端 B（插件进程中转，不落本地磁盘）
)

// State 任务状态。
type State string

const (
	Queued    State = "queued"
	Running   State = "running"
	Done      State = "done"
	Failed    State = "failed"
	Cancelled State = "cancelled"
)

// Task 是一次传输任务。
type Task struct {
	ID           string    `json:"id"`
	ConnectionID string    `json:"connectionId"`
	Direction    Direction `json:"direction"`
	RemotePath   string    `json:"remotePath"`
	LocalPath    string    `json:"localPath"`
	// ServerToServer：目标连接与目标路径。
	PeerConnectionID string `json:"peerConnectionId,omitempty"`
	PeerPath         string `json:"peerPath,omitempty"`

	mu         sync.Mutex
	state      State
	bytesDone  int64
	totalBytes int64
	err        error
	startedAt  time.Time
	endedAt    time.Time
	cancel     context.CancelFunc
}

// Status 是任务对外快照。
type Status struct {
	ID               string    `json:"id"`
	ConnectionID     string    `json:"connectionId"`
	Direction        Direction `json:"direction"`
	RemotePath       string    `json:"remotePath"`
	LocalPath        string    `json:"localPath"`
	PeerConnectionID string    `json:"peerConnectionId,omitempty"`
	PeerPath         string    `json:"peerPath,omitempty"`
	State            State     `json:"state"`
	BytesDone        int64     `json:"bytesDone"`
	TotalBytes       int64     `json:"totalBytes"`
	Error            string    `json:"error,omitempty"`
	StartedAt        time.Time `json:"startedAt"`
	EndedAt          time.Time `json:"endedAt,omitempty"`
	RateBps          int64     `json:"rateBps"`
}

func (t *Task) snapshot() Status {
	t.mu.Lock()
	defer t.mu.Unlock()
	st := Status{
		ID: t.ID, ConnectionID: t.ConnectionID, Direction: t.Direction,
		RemotePath: t.RemotePath, LocalPath: t.LocalPath,
		PeerConnectionID: t.PeerConnectionID, PeerPath: t.PeerPath,
		State: t.state, BytesDone: t.bytesDone, TotalBytes: t.totalBytes,
		StartedAt: t.startedAt, EndedAt: t.endedAt,
	}
	if t.err != nil {
		st.Error = t.err.Error()
	}
	if st.State == Running && t.bytesDone > 0 {
		elapsed := time.Since(t.startedAt).Seconds()
		if elapsed > 0.1 {
			st.RateBps = int64(float64(t.bytesDone) / elapsed)
		}
	}
	return st
}

// Manager 管理任务表；新任务立即异步执行。
type Manager struct {
	sftp *sftpops.Manager

	mu    sync.Mutex
	tasks map[string]*Task
	order []string // 保持创建顺序（列表展示）
}

func NewManager(s *sftpops.Manager) *Manager {
	return &Manager{sftp: s, tasks: map[string]*Task{}}
}

// Start 创建并启动一个传输任务。
func (m *Manager) Start(conn *sshclient.Conn, dir Direction, remotePath, localPath string) (*Task, error) {
	if remotePath == "" || localPath == "" {
		return nil, errors.New("remotePath and localPath are required")
	}
	id, err := newTaskID()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	t := &Task{
		ID: id, ConnectionID: conn.ID, Direction: dir,
		RemotePath: remotePath, LocalPath: localPath,
		state: Queued, cancel: cancel,
	}
	m.mu.Lock()
	m.tasks[id] = t
	m.order = append(m.order, id)
	// 任务表有界：保留最近 200 条，只淘汰已终结任务（运行中任务的
	// cancel 句柄丢失会导致 goroutine 失控）。
	if len(m.order) > 200 {
		var drop string
		for _, old := range m.order[:len(m.order)-200+1] {
			ot, ok := m.tasks[old]
			if !ok {
				drop = old
				break
			}
			ot.mu.Lock()
			st := ot.state
			ot.mu.Unlock()
			if st != Running && st != Queued {
				drop = old
				break
			}
		}
		if drop != "" {
			m.order = removeFromOrder(m.order, drop)
			delete(m.tasks, drop)
		}
	}
	m.mu.Unlock()

	go m.run(ctx, t, conn)
	return t, nil
}

// StartRemote 启动服务器到服务器的传输（插件进程中转：读 A 的 SFTP
// 流、写 B 的临时文件，完成后原子改名；内容不落本地磁盘）。
func (m *Manager) StartRemote(srcConn *sshclient.Conn, srcPath string, dstConn *sshclient.Conn, dstPath string) (*Task, error) {
	if srcPath == "" || dstPath == "" {
		return nil, errors.New("source and target paths are required")
	}
	if srcConn.ID == dstConn.ID {
		return nil, errors.New("source and target are the same connection")
	}
	id, err := newTaskID()
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	t := &Task{
		ID: id, ConnectionID: srcConn.ID, Direction: ServerToServer,
		RemotePath: srcPath, PeerConnectionID: dstConn.ID, PeerPath: dstPath,
		state: Queued, cancel: cancel,
	}
	m.addTask(t)
	go m.runRemote(ctx, t, srcConn, dstConn)
	return t, nil
}

// addTask 登记任务并维持有界任务表（只淘汰已终结任务）。
func (m *Manager) addTask(t *Task) {
	m.mu.Lock()
	m.tasks[t.ID] = t
	m.order = append(m.order, t.ID)
	if len(m.order) > 200 {
		var drop string
		for _, old := range m.order[:len(m.order)-200+1] {
			ot, ok := m.tasks[old]
			if !ok {
				drop = old
				break
			}
			ot.mu.Lock()
			st := ot.state
			ot.mu.Unlock()
			if st != Running && st != Queued {
				drop = old
				break
			}
		}
		if drop != "" {
			m.order = removeFromOrder(m.order, drop)
			delete(m.tasks, drop)
		}
	}
	m.mu.Unlock()
}

// runRemote 执行 A→B 的流式传输。
func (m *Manager) runRemote(ctx context.Context, t *Task, srcConn, dstConn *sshclient.Conn) {
	if err := m.serverToServer(ctx, t, srcConn, dstConn); err != nil {
		t.mu.Lock()
		t.endedAt = time.Now()
		if errors.Is(err, context.Canceled) {
			t.state = Cancelled
		} else {
			t.state = Failed
			t.err = err
		}
		t.mu.Unlock()
		return
	}
	t.mu.Lock()
	t.endedAt = time.Now()
	t.state = Done
	t.mu.Unlock()
}

// serverToServer 读源 SFTP 写目标 SFTP 临时名，完成后 PosixRename。
func (m *Manager) serverToServer(ctx context.Context, t *Task, srcConn, dstConn *sshclient.Conn) error {
	t.mu.Lock()
	t.state = Running
	t.startedAt = time.Now()
	t.mu.Unlock()

	srcClient, err := m.sftp.Client(srcConn)
	if err != nil {
		return err
	}
	dstClient, err := m.sftp.Client(dstConn)
	if err != nil {
		return err
	}
	src, err := srcClient.Open(t.RemotePath)
	if err != nil {
		return fmt.Errorf("open source: %w", err)
	}
	defer src.Close()
	info, err := src.Stat()
	if err != nil {
		return err
	}
	t.mu.Lock()
	t.totalBytes = info.Size()
	t.mu.Unlock()

	tmp := fmt.Sprintf("%s.copying-%s", t.PeerPath, t.ID)
	dst, err := dstClient.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC)
	if err != nil {
		return fmt.Errorf("create target temp: %w", err)
	}
	cleanup := func() { _ = dst.Close(); _ = dstClient.Remove(tmp) }
	if err := copyWithProgress(ctx, dst, src, t, 0); err != nil {
		cleanup()
		return err
	}
	if err := dst.Close(); err != nil {
		cleanup()
		return err
	}
	if err := dstClient.PosixRename(tmp, t.PeerPath); err != nil {
		if rerr := dstClient.Rename(tmp, t.PeerPath); rerr != nil {
			_ = dstClient.Remove(tmp)
			return rerr
		}
	}
	return nil
}

// run 执行传输：下载写 .part 再改名；上传写远端临时名再 PosixRename。
func (m *Manager) run(ctx context.Context, t *Task, conn *sshclient.Conn) {
	t.mu.Lock()
	t.state = Running
	t.startedAt = time.Now()
	t.mu.Unlock()

	var err error
	switch t.Direction {
	case Download:
		err = m.download(ctx, t, conn)
	case Upload:
		err = m.upload(ctx, t, conn)
	default:
		err = errors.New("unknown direction")
	}

	t.mu.Lock()
	t.endedAt = time.Now()
	switch {
	case err == nil:
		t.state = Done
	case errors.Is(err, context.Canceled):
		t.state = Cancelled
	default:
		t.state = Failed
		t.err = err
	}
	t.mu.Unlock()
}

// partMeta 绑定断点文件与远端来源（路径/大小/修改时间）：换源或远端
// 变化后旧 .part 不得再被续传或交付。
type partMeta struct {
	SourcePath string `json:"sourcePath"`
	Size       int64  `json:"size"`
	MTime      int64  `json:"mtime"`
}

func loadPartMeta(path string) (partMeta, error) {
	var meta partMeta
	data, err := os.ReadFile(path)
	if err != nil {
		return meta, err
	}
	if err := json.Unmarshal(data, &meta); err != nil {
		return partMeta{}, err
	}
	return meta, nil
}

func savePartMeta(path string, meta partMeta) error {
	data, err := json.Marshal(meta)
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

// download 远端 → 本地：.part 断点续传，完成后原子改名。
func (m *Manager) download(ctx context.Context, t *Task, conn *sshclient.Conn) error {
	client, err := m.sftp.Client(conn)
	if err != nil {
		return err
	}
	remote, err := client.Open(t.RemotePath)
	if err != nil {
		return fmt.Errorf("open remote: %w", err)
	}
	defer remote.Close()

	info, err := remote.Stat()
	if err != nil {
		return err
	}
	t.mu.Lock()
	t.totalBytes = info.Size()
	t.mu.Unlock()

	part := t.LocalPath + ".part"
	metaPath := part + ".meta"
	remoteMeta := partMeta{
		SourcePath: t.RemotePath, Size: info.Size(), MTime: info.ModTime().Unix(),
	}
	var offset int64
	if fi, err := os.Stat(part); err == nil {
		offset = fi.Size()
		// 已存在的 .part 必须与当前远端来源一致（路径/大小/mtime），
		// 否则视为换源或远端已变更：废弃断点，防止拼接或交付旧内容。
		stale := false
		if saved, merr := loadPartMeta(metaPath); merr != nil ||
			saved.SourcePath != remoteMeta.SourcePath ||
			saved.Size != remoteMeta.Size ||
			saved.MTime != remoteMeta.MTime {
			stale = true
		}
		if info.Size() == 0 || offset > info.Size() {
			stale = true
		}
		if stale {
			if rmErr := os.Remove(part); rmErr != nil && !os.IsNotExist(rmErr) {
				return fmt.Errorf("reset stale part file: %w", rmErr)
			}
			_ = os.Remove(metaPath)
			offset = 0
		}
	}
	// 远端是空文件：直接落空文件并清掉残留 .part。
	if info.Size() == 0 {
		f, cerr := os.OpenFile(t.LocalPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
		if cerr != nil {
			return fmt.Errorf("create local file: %w", cerr)
		}
		_ = f.Close()
		_ = os.Remove(part)
		_ = os.Remove(metaPath)
		return nil
	}
	if offset == 0 {
		if err := savePartMeta(metaPath, remoteMeta); err != nil {
			return fmt.Errorf("write part metadata: %w", err)
		}
	}
	t.mu.Lock()
	t.bytesDone = offset
	t.mu.Unlock()
	if offset >= info.Size() {
		// 上次已传完但没改名：直接进入收尾。
		if err := os.Rename(part, t.LocalPath); err != nil {
			return err
		}
		_ = os.Remove(metaPath)
		return nil
	}
	if _, err := remote.Seek(offset, io.SeekStart); err != nil {
		return err
	}
	f, err := os.OpenFile(part, os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("open local part file: %w", err)
	}
	defer f.Close()
	if _, err := f.Seek(offset, io.SeekStart); err != nil {
		return err
	}

	if err := copyWithProgress(ctx, f, remote, t, offset); err != nil {
		return err
	}
	// Windows 上目标文件仍被打开时 Rename 会失败：先显式关闭再改名。
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(part, t.LocalPath); err != nil {
		return err
	}
	_ = os.Remove(metaPath)
	return nil
}

// upload 本地 → 远端：写远端临时名，完成后 PosixRename 原子替换。
// 断点：远端临时文件已存在时从其大小续写。
func (m *Manager) upload(ctx context.Context, t *Task, conn *sshclient.Conn) error {
	client, err := m.sftp.Client(conn)
	if err != nil {
		return err
	}
	local, err := os.Open(t.LocalPath)
	if err != nil {
		return fmt.Errorf("open local: %w", err)
	}
	defer local.Close()
	info, err := local.Stat()
	if err != nil {
		return err
	}
	t.mu.Lock()
	t.totalBytes = info.Size()
	t.mu.Unlock()

	remoteTemp := fmt.Sprintf("%s.uploading-%s", t.RemotePath, t.ID)
	var offset int64
	if fi, err := client.Stat(remoteTemp); err == nil && fi.Size() <= info.Size() {
		offset = fi.Size()
	}
	t.mu.Lock()
	t.bytesDone = offset
	t.mu.Unlock()
	if offset >= info.Size() && info.Size() >= 0 && offset > 0 {
		if err := client.PosixRename(remoteTemp, t.RemotePath); err != nil {
			// 服务器不支持 posix-rename 时退回普通改名。
			return client.Rename(remoteTemp, t.RemotePath)
		}
		return nil
	}
	if _, err := local.Seek(offset, io.SeekStart); err != nil {
		return err
	}
	flags := os.O_CREATE | os.O_WRONLY
	if offset == 0 {
		flags |= os.O_TRUNC
	}
	remote, err := client.OpenFile(remoteTemp, flags)
	if err != nil {
		return fmt.Errorf("open remote temp: %w", err)
	}
	defer remote.Close()
	if _, err := remote.Seek(offset, io.SeekStart); err != nil {
		return err
	}

	if err := copyWithProgress(ctx, remote, local, t, offset); err != nil {
		return err
	}
	// 显式关闭远端临时文件句柄后再改名（POSIX 语义宽松，但保持与
	// 本地侧一致，避免依赖服务端对已打开文件 rename 的实现差异）。
	if err := remote.Close(); err != nil {
		return err
	}
	if err := client.PosixRename(remoteTemp, t.RemotePath); err != nil {
		return client.Rename(remoteTemp, t.RemotePath)
	}
	return nil
}

// copyWithProgress 带 ctx 取消与进度回写的数据拷贝。
func copyWithProgress(ctx context.Context, dst io.Writer, src io.Reader, t *Task, startOffset int64) error {
	buf := make([]byte, 256*1024)
	var written int64
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		n, rerr := src.Read(buf)
		if n > 0 {
			if _, werr := dst.Write(buf[:n]); werr != nil {
				return werr
			}
			written += int64(n)
			t.mu.Lock()
			t.bytesDone = startOffset + written
			t.mu.Unlock()
		}
		if rerr == io.EOF {
			return nil
		}
		if rerr != nil {
			return rerr
		}
	}
}

// Status 查询单个任务。
func (m *Manager) Status(id string) (Status, bool) {
	m.mu.Lock()
	t, ok := m.tasks[id]
	m.mu.Unlock()
	if !ok {
		return Status{}, false
	}
	return t.snapshot(), true
}

// List 返回任务列表（按创建顺序倒序，最新在前）。
func (m *Manager) List() []Status {
	m.mu.Lock()
	ids := append([]string{}, m.order...)
	tasks := make([]*Task, 0, len(ids))
	for _, id := range ids {
		if t, ok := m.tasks[id]; ok {
			tasks = append(tasks, t)
		}
	}
	m.mu.Unlock()
	out := make([]Status, 0, len(tasks))
	for i := len(tasks) - 1; i >= 0; i-- {
		out = append(out, tasks[i].snapshot())
	}
	return out
}

// Cancel 取消任务（running 或 queued）。
func (m *Manager) Cancel(id string) error {
	m.mu.Lock()
	t, ok := m.tasks[id]
	m.mu.Unlock()
	if !ok {
		return errors.New("task not found")
	}
	t.mu.Lock()
	state := t.state
	t.mu.Unlock()
	if state != Running && state != Queued {
		return fmt.Errorf("task is %s", state)
	}
	t.cancel()
	return nil
}

// CloseAll 取消全部运行中任务（进程退出前清理）。
func (m *Manager) CloseAll() {
	m.mu.Lock()
	tasks := make([]*Task, 0, len(m.tasks))
	for _, t := range m.tasks {
		tasks = append(tasks, t)
	}
	m.mu.Unlock()
	for _, t := range tasks {
		t.mu.Lock()
		st := t.state
		t.mu.Unlock()
		if st == Running || st == Queued {
			t.cancel()
		}
	}
}

// Retry 重试一个失败/取消的任务（断点续传）。
func (m *Manager) Retry(id string, conn *sshclient.Conn) (string, error) {
	m.mu.Lock()
	old, ok := m.tasks[id]
	m.mu.Unlock()
	if !ok {
		return "", errors.New("task not found")
	}
	s := old.snapshot()
	if s.State != Failed && s.State != Cancelled {
		return "", fmt.Errorf("only failed or cancelled tasks can retry")
	}
	nt, err := m.Start(conn, s.Direction, s.RemotePath, s.LocalPath)
	if err != nil {
		return "", err
	}
	return nt.ID, nil
}

func newTaskID() (string, error) {
	buf := make([]byte, 10)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return "x_" + base64.RawURLEncoding.EncodeToString(buf), nil
}

// removeFromOrder 从顺序表删除一个元素。
func removeFromOrder(order []string, id string) []string {
	for i, v := range order {
		if v == id {
			return append(order[:i], order[i+1:]...)
		}
	}
	return order
}
