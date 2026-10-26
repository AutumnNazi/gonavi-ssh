// Package sftpops 封装远程文件系统（SFTP）与本地文件系统操作。
// SFTP client 按连接缓存复用；所有操作不传输文件内容过桥——
// 大文件传输走 transfer 模块的磁盘直传。
package sftpops

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pkg/sftp"

	"gonavi-ssh/internal/sshclient"
)

// Entry 是目录条目的统一视图（远程与本地同构）。
type Entry struct {
	Name   string    `json:"name"`
	Path   string    `json:"path"`
	Size   int64     `json:"size"`
	Mode   string    `json:"mode"`
	IsDir  bool      `json:"isDir"`
	IsLink bool      `json:"isLink"`
	Mtime  time.Time `json:"mtime"`
}

// Manager 按 connectionId 缓存 sftp.Client。
type Manager struct {
	mu      sync.Mutex
	clients map[string]*sftp.Client
}

func NewManager() *Manager {
	return &Manager{clients: map[string]*sftp.Client{}}
}

func (m *Manager) client(conn *sshclient.Conn) (*sftp.Client, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if c, ok := m.clients[conn.ID]; ok {
		return c, nil
	}
	c, err := sftp.NewClient(conn.Client())
	if err != nil {
		return nil, fmt.Errorf("open sftp channel: %w", err)
	}
	m.clients[conn.ID] = c
	return c, nil
}

// Client 返回连接的 sftp 客户端（缓存复用）；transfer 模块也用它直传。
func (m *Manager) Client(conn *sshclient.Conn) (*sftp.Client, error) {
	return m.client(conn)
}

// Close 丢弃某连接的 sftp client（连接关闭时调用）。
func (m *Manager) Close(connectionID string) {
	m.mu.Lock()
	if c, ok := m.clients[connectionID]; ok {
		_ = c.Close()
		delete(m.clients, connectionID)
	}
	m.mu.Unlock()
}

// CloseAll 关闭全部 sftp client。
func (m *Manager) CloseAll() {
	m.mu.Lock()
	for id, c := range m.clients {
		_ = c.Close()
		delete(m.clients, id)
	}
	m.mu.Unlock()
}

// List 分页列远程目录；limit<=0 用默认 500，返回条目与是否还有更多。
// sortBy：""/name（名称，默认）、size、mtime；目录恒定排前。
func (m *Manager) List(conn *sshclient.Conn, dir string, offset, limit int, sortBy string) ([]Entry, bool, error) {
	if offset < 0 {
		return nil, false, errors.New("offset must be >= 0")
	}
	if limit <= 0 {
		limit = 500
	}
	c, err := m.client(conn)
	if err != nil {
		return nil, false, err
	}
	infos, err := c.ReadDir(remoteClean(dir))
	if err != nil {
		return nil, false, fmt.Errorf("read dir: %w", err)
	}
	sortEntriesBy(infos, sortBy)
	end := offset + limit
	more := false
	if end < len(infos) {
		more = true
		infos = infos[:end]
	}
	if offset >= len(infos) {
		return []Entry{}, false, nil
	}
	out := make([]Entry, 0, limit)
	for _, fi := range infos[offset:] {
		out = append(out, remoteEntry(dir, fi))
	}
	return out, more, nil
}

// sortEntriesBy 目录优先，其次按声明维度排序（默认名称）。
func sortEntriesBy(infos []fs.FileInfo, sortBy string) {
	sort.SliceStable(infos, func(i, j int) bool {
		if infos[i].IsDir() != infos[j].IsDir() {
			return infos[i].IsDir()
		}
		switch sortBy {
		case "size":
			if infos[i].Size() != infos[j].Size() {
				return infos[i].Size() > infos[j].Size()
			}
		case "mtime":
			if !infos[i].ModTime().Equal(infos[j].ModTime()) {
				return infos[i].ModTime().After(infos[j].ModTime())
			}
		}
		return infos[i].Name() < infos[j].Name()
	})
}

// sortEntries 保留旧名兼容（名称排序）。
func sortEntries(infos []fs.FileInfo) { sortEntriesBy(infos, "") }

func remoteEntry(dir string, fi os.FileInfo) Entry {
	mode := fi.Mode().String()
	return Entry{
		Name: fi.Name(), Path: joinRemote(dir, fi.Name()),
		Size: fi.Size(), Mode: mode,
		IsDir: fi.IsDir(), IsLink: fi.Mode()&fs.ModeSymlink != 0,
		Mtime: fi.ModTime(),
	}
}

// Stat 查看单个路径。
func (m *Manager) Stat(conn *sshclient.Conn, path string) (Entry, error) {
	c, err := m.client(conn)
	if err != nil {
		return Entry{}, err
	}
	clean := remoteClean(path)
	fi, err := c.Stat(clean)
	if err != nil {
		return Entry{}, fmt.Errorf("stat: %w", err)
	}
	parent := "/"
	if idx := strings.LastIndex(clean, "/"); idx > 0 {
		parent = clean[:idx]
	}
	return remoteEntry(parent, fi), nil
}

// Mkdir 建目录（单层）。
func (m *Manager) Mkdir(conn *sshclient.Conn, path string) error {
	c, err := m.client(conn)
	if err != nil {
		return err
	}
	return c.Mkdir(remoteClean(path))
}

// Rename 重命名/移动。
func (m *Manager) Rename(conn *sshclient.Conn, oldPath, newPath string) error {
	c, err := m.client(conn)
	if err != nil {
		return err
	}
	return c.Rename(remoteClean(oldPath), remoteClean(newPath))
}

// Chmod 改权限。
func (m *Manager) Chmod(conn *sshclient.Conn, path string, mode uint32) error {
	c, err := m.client(conn)
	if err != nil {
		return err
	}
	return c.Chmod(remoteClean(path), fs.FileMode(mode))
}

// Remove 删除单个文件。
func (m *Manager) Remove(conn *sshclient.Conn, path string) error {
	c, err := m.client(conn)
	if err != nil {
		return err
	}
	return c.Remove(remoteClean(path))
}

// RemoveRecursive 递归删除文件或目录树。顶层用 Lstat：符号链接只删
// 链接本身，不跟随删穿目标树（对齐 rm -rf 语义）；子条目来自 readdir
// 的 lstat 语义，天然不跟随。
func (m *Manager) RemoveRecursive(conn *sshclient.Conn, path string) error {
	c, err := m.client(conn)
	if err != nil {
		return err
	}
	path = remoteClean(path)
	fi, err := c.Lstat(path)
	if err != nil {
		return err
	}
	if fi.IsDir() {
		return m.removeDirRecursive(c, path)
	}
	return c.Remove(path)
}

func (m *Manager) removeDirRecursive(c *sftp.Client, path string) error {
	infos, err := c.ReadDir(path)
	if err != nil {
		return err
	}
	for _, info := range infos {
		child := joinRemote(path, info.Name())
		if info.IsDir() {
			if err := m.removeDirRecursive(c, child); err != nil {
				return err
			}
			continue
		}
		if err := c.Remove(child); err != nil {
			return err
		}
	}
	return c.RemoveDirectory(path)
}

// ReadPreview 读小文件内容（maxBytes 上限，用于文本预览）。
func (m *Manager) ReadPreview(conn *sshclient.Conn, path string, maxBytes int64) ([]byte, error) {
	if maxBytes <= 0 || maxBytes > 512*1024 {
		maxBytes = 256 * 1024
	}
	c, err := m.client(conn)
	if err != nil {
		return nil, err
	}
	f, err := c.Open(remoteClean(path))
	if err != nil {
		return nil, fmt.Errorf("open: %w", err)
	}
	defer f.Close()
	return io.ReadAll(io.LimitReader(f, maxBytes))
}

// WriteFile 写小文件（覆盖）；大文件请走 transfer 上传。
func (m *Manager) WriteFile(conn *sshclient.Conn, path string, content []byte) error {
	if len(content) > 512*1024 {
		return errors.New("content too large; use transfer upload instead")
	}
	c, err := m.client(conn)
	if err != nil {
		return err
	}
	f, err := c.Create(remoteClean(path))
	if err != nil {
		return fmt.Errorf("create: %w", err)
	}
	defer f.Close()
	_, err = f.Write(content)
	return err
}

// DiskUsage 返回路径所在文件系统的用量（需服务器支持 statvfs 扩展）。
type DiskUsage struct {
	TotalBytes uint64 `json:"totalBytes"`
	FreeBytes  uint64 `json:"freeBytes"`
	AvailBytes uint64 `json:"availBytes"`
}

func (m *Manager) DiskUsage(conn *sshclient.Conn, path string) (DiskUsage, error) {
	c, err := m.client(conn)
	if err != nil {
		return DiskUsage{}, err
	}
	vfs, err := c.StatVFS(remoteClean(path))
	if err != nil {
		return DiskUsage{}, fmt.Errorf("statvfs not supported: %w", err)
	}
	return DiskUsage{
		TotalBytes: vfs.TotalSpace(),
		FreeBytes:  vfs.FreeSpace(),
		AvailBytes: vfs.Frsize * vfs.Bavail, // 非特权用户可用空间
	}, nil
}

// Pwd 返回远端指定路径的规范绝对路径（realpath "." 即当前目录）。
func (m *Manager) Pwd(conn *sshclient.Conn, path string) (string, error) {
	c, err := m.client(conn)
	if err != nil {
		return "", err
	}
	if strings.TrimSpace(path) == "" {
		path = "."
	}
	return c.RealPath(remoteClean(path))
}

// Copy 在远端复制文件（服务器端流式读写，数据不过桥）。
func (m *Manager) Copy(conn *sshclient.Conn, srcPath, dstPath string) error {
	c, err := m.client(conn)
	if err != nil {
		return err
	}
	src, err := c.Open(remoteClean(srcPath))
	if err != nil {
		return fmt.Errorf("open src: %w", err)
	}
	defer src.Close()
	info, err := src.Stat()
	if err != nil {
		return err
	}
	if info.IsDir() {
		return errors.New("copy supports files only; copy a directory tree via download+upload")
	}
	dst, err := c.Create(remoteClean(dstPath))
	if err != nil {
		return fmt.Errorf("create dst: %w", err)
	}
	defer dst.Close()
	buf := make([]byte, 256*1024)
	_, err = io.CopyBuffer(dst, src, buf)
	return err
}

// ---- 本地侧（插件进程直接以当前用户权限访问文件系统） ----

// ListLocal 列本地目录；支持盘符根（Windows 盘符列表）。
func ListLocal(dir string) ([]Entry, error) {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return listDrives()
	}
	infos, err := os.ReadDir(dir)
	if err != nil {
		return nil, fmt.Errorf("read local dir: %w", err)
	}
	entries := make([]Entry, 0, len(infos))
	for _, de := range infos {
		info, err := de.Info()
		if err != nil {
			continue // 权限或竞态导致的单条失败跳过
		}
		entries = append(entries, Entry{
			Name: de.Name(), Path: filepath.Join(dir, de.Name()),
			Size: info.Size(), Mode: info.Mode().String(),
			IsDir: de.IsDir(), IsLink: de.Type()&fs.ModeSymlink != 0,
			Mtime: info.ModTime(),
		})
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDir != entries[j].IsDir {
			return entries[i].IsDir
		}
		return entries[i].Name < entries[j].Name
	})
	return entries, nil
}

// LocalHome 返回本地用户目录（UI 初始路径）。
func LocalHome() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return "."
	}
	return home
}

// listDrives 列出可选根：Windows 返回盘符列表，其他平台返回 /。
func listDrives() ([]Entry, error) {
	entries := []Entry{}
	if runtime.GOOS == "windows" {
		for c := 'A'; c <= 'Z'; c++ {
			root := string(c) + `:\`
			if _, err := os.Stat(root); err == nil {
				entries = append(entries, Entry{Name: root, Path: root, IsDir: true, Mode: "driv"})
			}
		}
		return entries, nil
	}
	return []Entry{{Name: "/", Path: "/", IsDir: true, Mode: "drwxr-xr-x"}}, nil
}

// remoteClean 统一路径分隔符与结尾斜杠。
func remoteClean(p string) string {
	p = strings.TrimSpace(p)
	if p == "" {
		return "."
	}
	return p
}

// joinRemote 拼接远程路径（POSIX 语义）。
func joinRemote(dir, name string) string {
	if dir == "" || dir == "." {
		return name
	}
	return strings.TrimSuffix(dir, "/") + "/" + name
}
