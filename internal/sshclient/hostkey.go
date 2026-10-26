package sshclient

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"golang.org/x/crypto/ssh"
)

// knownHosts 实现 TOFU（trust on first use）主机密钥策略：
// 首次连接记录指纹，之后每次比对；指纹变化一律拒绝连接并明确报出
// 新旧指纹差异，防止中间人静默降级。存储格式为每行一条：
//
//	host:port <base64(ssh 公钥 marshal)>
type knownHosts struct {
	mu    sync.Mutex
	path  string
	hosts map[string]ssh.PublicKey
}

func loadKnownHosts(dir string) (*knownHosts, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}
	kh := &knownHosts{
		path:  filepath.Join(dir, "known_hosts"),
		hosts: map[string]ssh.PublicKey{},
	}
	data, err := os.ReadFile(kh.path)
	if errors.Is(err, os.ErrNotExist) {
		return kh, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read known_hosts: %w", err)
	}
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		addr, keyB64, ok := strings.Cut(line, " ")
		if !ok {
			continue
		}
		key, err := parseStoredKey(keyB64)
		if err != nil {
			continue // 单行损坏跳过，不阻断整个信任库
		}
		kh.hosts[addr] = key
	}
	return kh, nil
}

func parseStoredKey(keyB64 string) (ssh.PublicKey, error) {
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(keyB64))
	if err != nil {
		return nil, err
	}
	return ssh.ParsePublicKey(raw)
}

// callback 返回按远端实际地址记录的默认 HostKeyCallback。
func (kh *knownHosts) callback() ssh.HostKeyCallback {
	return func(_ string, remote net.Addr, key ssh.PublicKey) error {
		return kh.checkAndRecord(normalizeAddr(remote.String()), key)
	}
}

// callbackFor 返回按逻辑地址（声明的主机:端口）记录的 HostKeyCallback。
// 经跳板隧道拨号时远端地址是隧道入口（如 127.0.0.1:x），必须按声明地址
// 记录指纹，否则所有跳板后主机都会撞同一条 known_hosts 记录。
func (kh *knownHosts) callbackFor(logicalAddr string) ssh.HostKeyCallback {
	return func(_ string, _ net.Addr, key ssh.PublicKey) error {
		return kh.checkAndRecord(normalizeAddr(logicalAddr), key)
	}
}

// checkAndRecord 执行 TOFU 判定：未记录则记录；一致放行；变更拒绝。
func (kh *knownHosts) checkAndRecord(addr string, key ssh.PublicKey) error {
	kh.mu.Lock()
	defer kh.mu.Unlock()
	known, ok := kh.hosts[addr]
	if !ok {
		if err := kh.recordLocked(addr, key); err != nil {
			return fmt.Errorf("record host key: %w", err)
		}
		return nil
	}
	if !keysEqual(known, key) {
		return fmt.Errorf(
			"HOST KEY CHANGED for %s: known %s, got %s; possible man-in-the-middle. Connection refused",
			addr, ssh.FingerprintSHA256(known), ssh.FingerprintSHA256(key))
	}
	return nil
}

// keysEqual 比较两把公钥：类型与序列化字节都一致才视为同一把钥匙。
func keysEqual(a, b ssh.PublicKey) bool {
	return a.Type() == b.Type() && bytes.Equal(a.Marshal(), b.Marshal())
}

// recordLocked 首次见到该主机时追加记录；调用方持有锁。
func (kh *knownHosts) recordLocked(addr string, key ssh.PublicKey) error {
	line := fmt.Sprintf("%s %s\n", addr, base64.StdEncoding.EncodeToString(key.Marshal()))
	f, err := os.OpenFile(kh.path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	defer f.Close()
	if _, err := f.WriteString(line); err != nil {
		return err
	}
	kh.hosts[addr] = key
	return nil
}

// Fingerprint 返回已记录主机的指纹（未记录返回空串），供 UI 展示。
func (kh *knownHosts) Fingerprint(addr string) string {
	kh.mu.Lock()
	defer kh.mu.Unlock()
	key, ok := kh.hosts[normalizeAddr(addr)]
	if !ok {
		return ""
	}
	return ssh.FingerprintSHA256(key)
}

// KnownHostEntry 是已知主机记录的对外视图。
type KnownHostEntry struct {
	Addr        string `json:"addr"`
	Fingerprint string `json:"fingerprint"`
	KeyType     string `json:"keyType"`
}

// List 返回全部已信任主机（按地址排序）。
func (kh *knownHosts) List() []KnownHostEntry {
	kh.mu.Lock()
	defer kh.mu.Unlock()
	out := make([]KnownHostEntry, 0, len(kh.hosts))
	for addr, key := range kh.hosts {
		out = append(out, KnownHostEntry{
			Addr: addr, Fingerprint: ssh.FingerprintSHA256(key), KeyType: key.Type(),
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Addr < out[j].Addr })
	return out
}

// Remove 删除一条信任记录并重写 known_hosts；不存在返回 false。
func (kh *knownHosts) Remove(addr string) bool {
	addr = normalizeAddr(addr)
	kh.mu.Lock()
	defer kh.mu.Unlock()
	if _, ok := kh.hosts[addr]; !ok {
		return false
	}
	delete(kh.hosts, addr)
	// 重写整个文件（记录量小，简单可靠）。
	var b strings.Builder
	for a, key := range kh.hosts {
		fmt.Fprintf(&b, "%s %s\n", a, base64.StdEncoding.EncodeToString(key.Marshal()))
	}
	return os.WriteFile(kh.path, []byte(b.String()), 0o600) == nil
}

// normalizeAddr 把 remote 地址统一为 host:port；缺端口补 22。
func normalizeAddr(addr string) string {
	if _, _, err := net.SplitHostPort(addr); err != nil {
		return net.JoinHostPort(strings.Trim(addr, "[]"), "22")
	}
	return addr
}
