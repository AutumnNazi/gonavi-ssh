// Package profile 管理 SSH 连接档案：主机、端口、用户、认证方式。
// 密码与私钥口令属于敏感字段，落盘时使用数据目录内主密钥做 AES-GCM 加密，
// 永不明文写入 profiles.json，也永不进入日志与错误信息。
package profile

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// AuthMethod 是档案声明的认证方式。
type AuthMethod string

const (
	AuthPassword AuthMethod = "password" // 密码认证
	AuthKey      AuthMethod = "key"      // 私钥文件认证（可选口令）
	AuthAgent    AuthMethod = "agent"    // SSH Agent 认证
	AuthNone     AuthMethod = "none"     // 无认证（开放 SSH 账号）
)

// Jump 描述一跳跳板机；最多三跳（对齐 OpenSSH ProxyJump 的常见上限）。
// 敏感字段与主档案同样加密落盘。
type Jump struct {
	Host       string     `json:"host"`
	Port       int        `json:"port"`
	User       string     `json:"user"`
	AuthMethod AuthMethod `json:"authMethod"`
	KeyPath    string     `json:"keyPath,omitempty"`
	Password   string     `json:"-"`
	Passphrase string     `json:"-"`
}

const maxJumps = 3

// Profile 描述一台 SSH 服务器。Password/Passphrase/Jumps 敏感字段仅存在
// 于内存，序列化时走 sealed 字段。
type Profile struct {
	ID         string     `json:"id"`
	Name       string     `json:"name"`
	Host       string     `json:"host"`
	Port       int        `json:"port"` // 0 视为默认 22
	User       string     `json:"user"`
	AuthMethod AuthMethod `json:"authMethod"`
	KeyPath    string     `json:"keyPath,omitempty"`

	// ProxyJump 跳板链：按顺序经过。
	Jumps []Jump `json:"-"`

	// 敏感字段：不参与 JSON 序列化，落盘时加密。
	Password     string `json:"-"`
	Passphrase   string `json:"-"`
	SudoPassword string `json:"-"` // Quick Sudo：sudo 提权密码（可空=NOPASSWD 场景）
	// CorruptSecrets 标记密文解密失败（密钥文件更换/文件损坏），
	// 对外提示用户重录密码而不是呈现莫名的认证失败。
	CorruptSecrets bool `json:"-"`

	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// HasPassword 反映内存中的档案是否带有密码，用于对外展示。
func (p Profile) HasPassword() bool   { return p.Password != "" }
func (p Profile) HasPassphrase() bool { return p.Passphrase != "" }

// Sanitized 返回不含敏感明文的档案视图，供命令响应使用。
type JumpView struct {
	Host          string     `json:"host"`
	Port          int        `json:"port"`
	User          string     `json:"user"`
	AuthMethod    AuthMethod `json:"authMethod"`
	KeyPath       string     `json:"keyPath,omitempty"`
	HasPassword   bool       `json:"hasPassword"`
	HasPassphrase bool       `json:"hasPassphrase"`
}

type Sanitized struct {
	ID              string     `json:"id"`
	Name            string     `json:"name"`
	Host            string     `json:"host"`
	Port            int        `json:"port"`
	User            string     `json:"user"`
	AuthMethod      AuthMethod `json:"authMethod"`
	KeyPath         string     `json:"keyPath,omitempty"`
	Jumps           []JumpView `json:"jumps,omitempty"`
	HasPassword     bool       `json:"hasPassword"`
	HasPassphrase   bool       `json:"hasPassphrase"`
	HasSudoPassword bool       `json:"hasSudoPassword"`
	// CorruptSecrets 为 true 时已存密码无法解密，UI 应提示重录。
	CorruptSecrets bool      `json:"corruptSecrets,omitempty"`
	UpdatedAt      time.Time `json:"updatedAt"`
}

func sanitizeJumps(jumps []Jump) []JumpView {
	if len(jumps) == 0 {
		return nil
	}
	out := make([]JumpView, 0, len(jumps))
	for _, j := range jumps {
		port := j.Port
		if port == 0 {
			port = 22
		}
		out = append(out, JumpView{
			Host: j.Host, Port: port, User: j.User,
			AuthMethod: j.AuthMethod, KeyPath: j.KeyPath,
			HasPassword: j.Password != "", HasPassphrase: j.Passphrase != "",
		})
	}
	return out
}

func (p Profile) Sanitized() Sanitized {
	port := p.Port
	if port == 0 {
		port = 22
	}
	return Sanitized{
		ID: p.ID, Name: p.Name, Host: p.Host, Port: port, User: p.User,
		AuthMethod: p.AuthMethod, KeyPath: p.KeyPath,
		Jumps:       sanitizeJumps(p.Jumps),
		HasPassword: p.HasPassword(), HasPassphrase: p.HasPassphrase(),
		HasSudoPassword: p.SudoPassword != "",
		CorruptSecrets:  p.CorruptSecrets,
		UpdatedAt:       p.UpdatedAt,
	}
}

// Validate 校验档案必填字段；错误信息不含敏感内容。
func (p *Profile) Validate() error {
	p.Host = strings.TrimSpace(p.Host)
	p.User = strings.TrimSpace(p.User)
	p.Name = strings.TrimSpace(p.Name)
	if p.Name == "" {
		return errors.New("name is required")
	}
	if p.Host == "" {
		return errors.New("host is required")
	}
	if p.User == "" {
		return errors.New("user is required")
	}
	if p.Port < 0 || p.Port > 65535 {
		return errors.New("port out of range")
	}
	if err := validateAuth(p.AuthMethod, p.KeyPath); err != nil {
		return err
	}
	if len(p.Jumps) > maxJumps {
		return fmt.Errorf("at most %d proxy jumps are supported", maxJumps)
	}
	for i := range p.Jumps {
		j := &p.Jumps[i]
		j.Host = strings.TrimSpace(j.Host)
		j.User = strings.TrimSpace(j.User)
		if j.Host == "" {
			return fmt.Errorf("jump %d: host is required", i+1)
		}
		if j.User == "" {
			return fmt.Errorf("jump %d: user is required", i+1)
		}
		if j.Port < 0 || j.Port > 65535 {
			return fmt.Errorf("jump %d: port out of range", i+1)
		}
		if err := validateAuth(j.AuthMethod, j.KeyPath); err != nil {
			return fmt.Errorf("jump %d: %w", i+1, err)
		}
	}
	return nil
}

func validateAuth(method AuthMethod, keyPath string) error {
	switch method {
	case AuthPassword, AuthAgent, AuthNone:
		return nil
	case AuthKey:
		if strings.TrimSpace(keyPath) == "" {
			return errors.New("keyPath is required for key auth")
		}
		return nil
	default:
		return fmt.Errorf("unsupported authMethod %q", method)
	}
}

// storedProfile 是 profiles.json 中的单条记录。敏感字段以
// "<nonce>:<ciphertext>" 的 base64 密文存放；空串表示未设置。
// Jumps（含各跳敏感字段）整体序列化后加密。
type storedProfile struct {
	ID                 string     `json:"id"`
	Name               string     `json:"name"`
	Host               string     `json:"host"`
	Port               int        `json:"port"`
	User               string     `json:"user"`
	AuthMethod         AuthMethod `json:"authMethod"`
	KeyPath            string     `json:"keyPath,omitempty"`
	PasswordSealed     string     `json:"passwordSealed,omitempty"`
	PassphraseSealed   string     `json:"passphraseSealed,omitempty"`
	SudoPasswordSealed string     `json:"sudoPasswordSealed,omitempty"`
	JumpsSealed        string     `json:"jumpsSealed,omitempty"`
	CreatedAt          time.Time  `json:"createdAt"`
	UpdatedAt          time.Time  `json:"updatedAt"`
}

type storedFile struct {
	Profiles []storedProfile `json:"profiles"`
}

// Store 负责 profiles.json 的读写与敏感字段加解密。
// 全量读→改→原子写回，进程内由互斥锁串行化。
type Store struct {
	dir      string
	mu       sync.Mutex
	key      []byte
	profiles map[string]Profile
}

const (
	profilesFile = "profiles.json"
	keyFile      = "secret.key"
	keySize      = 32 // AES-256
)

// Open 加载或初始化数据目录：<dir>/profiles.json 与 <dir>/secret.key。
func Open(dir string) (*Store, error) {
	if strings.TrimSpace(dir) == "" {
		return nil, errors.New("profile store requires a data directory")
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}
	s := &Store{dir: dir, profiles: map[string]Profile{}}

	// 主密钥：首次生成 32 字节随机并限定 0600。密钥与密文同目录，
	// 保护级别等于该目录的文件系统权限（Windows 下尽力设置）。
	keyPath := filepath.Join(dir, keyFile)
	key, err := os.ReadFile(keyPath)
	switch {
	case err == nil:
		if len(key) != keySize {
			return nil, fmt.Errorf("corrupt key file %s", keyFile)
		}
	case errors.Is(err, os.ErrNotExist):
		key = make([]byte, keySize)
		if _, cerr := io.ReadFull(rand.Reader, key); cerr != nil {
			return nil, fmt.Errorf("generate key: %w", cerr)
		}
		if werr := atomicWriteFile(keyPath, key, 0o600); werr != nil {
			return nil, fmt.Errorf("persist key: %w", werr)
		}
	default:
		return nil, fmt.Errorf("read key file: %w", err)
	}
	s.key = key

	data, err := os.ReadFile(filepath.Join(dir, profilesFile))
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read profiles: %w", err)
	}
	var file storedFile
	if len(data) == 0 {
		return s, nil
	}
	if err := json.Unmarshal(data, &file); err != nil {
		return nil, fmt.Errorf("parse profiles: %w", err)
	}
	for _, sp := range file.Profiles {
		p := Profile{
			ID: sp.ID, Name: sp.Name, Host: sp.Host, Port: sp.Port, User: sp.User,
			AuthMethod: sp.AuthMethod, KeyPath: sp.KeyPath,
			CreatedAt: sp.CreatedAt, UpdatedAt: sp.UpdatedAt,
		}
		if sp.PasswordSealed != "" {
			if plain, derr := s.sealOpen(sp.PasswordSealed); derr == nil {
				p.Password = plain
			} else {
				p.CorruptSecrets = true
			}
		}
		if sp.PassphraseSealed != "" {
			if plain, derr := s.sealOpen(sp.PassphraseSealed); derr == nil {
				p.Passphrase = plain
			} else {
				p.CorruptSecrets = true
			}
		}
		if sp.SudoPasswordSealed != "" {
			if plain, derr := s.sealOpen(sp.SudoPasswordSealed); derr == nil {
				p.SudoPassword = plain
			} else {
				p.CorruptSecrets = true
			}
		}
		if sp.JumpsSealed != "" {
			if plain, derr := s.sealOpen(sp.JumpsSealed); derr == nil {
				var jumps []Jump
				if jerr := json.Unmarshal([]byte(plain), &jumps); jerr == nil {
					p.Jumps = jumps
				}
			}
		}
		s.profiles[p.ID] = p
	}
	return s, nil
}

// List 返回全部档案（含敏感明文，仅在插件进程内部使用）。
func (s *Store) List() []Profile {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]Profile, 0, len(s.profiles))
	for _, p := range s.profiles {
		out = append(out, p)
	}
	return out
}

// Get 按 ID 返回档案；不存在时返回 false。
func (s *Store) Get(id string) (Profile, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, ok := s.profiles[id]
	return p, ok
}

// Upsert 新建或更新档案。id 为空时生成新 ID；更新时敏感字段留空表示沿用旧值。
func (s *Store) Upsert(p Profile) (Profile, error) {
	if err := p.Validate(); err != nil {
		return Profile{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()
	if p.ID == "" {
		id, err := newID()
		if err != nil {
			return Profile{}, err
		}
		p.ID = id
		p.CreatedAt = now
	} else if old, ok := s.profiles[p.ID]; ok {
		p.CreatedAt = old.CreatedAt
		if p.Password == "" {
			p.Password = old.Password
		}
		if p.Passphrase == "" {
			p.Passphrase = old.Passphrase
		}
		if p.SudoPassword == "" {
			p.SudoPassword = old.SudoPassword
		}
		// jumps 为 nil 表示本次未提供（沿用旧值）；显式空数组表示清空。
		if p.Jumps == nil {
			p.Jumps = old.Jumps
		}
	}
	p.UpdatedAt = now
	s.profiles[p.ID] = p
	if err := s.flushLocked(); err != nil {
		return Profile{}, err
	}
	return p, nil
}

// Delete 删除档案；不存在不是错误。
func (s *Store) Delete(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.profiles, id)
	return s.flushLocked()
}

// flushLocked 把当前档案表整体写回 profiles.json；调用方必须持有锁。
func (s *Store) flushLocked() error {
	file := storedFile{Profiles: make([]storedProfile, 0, len(s.profiles))}
	for _, p := range s.profiles {
		sp := storedProfile{
			ID: p.ID, Name: p.Name, Host: p.Host, Port: p.Port, User: p.User,
			AuthMethod: p.AuthMethod, KeyPath: p.KeyPath,
			CreatedAt: p.CreatedAt, UpdatedAt: p.UpdatedAt,
		}
		if p.Password != "" {
			sealed, err := s.sealSeal(p.Password)
			if err != nil {
				return err
			}
			sp.PasswordSealed = sealed
		}
		if p.Passphrase != "" {
			sealed, err := s.sealSeal(p.Passphrase)
			if err != nil {
				return err
			}
			sp.PassphraseSealed = sealed
		}
		if p.SudoPassword != "" {
			sealed, err := s.sealSeal(p.SudoPassword)
			if err != nil {
				return err
			}
			sp.SudoPasswordSealed = sealed
		}
		if len(p.Jumps) > 0 {
			raw, err := json.Marshal(p.Jumps)
			if err != nil {
				return err
			}
			sealed, err := s.sealSeal(string(raw))
			if err != nil {
				return err
			}
			sp.JumpsSealed = sealed
		}
		file.Profiles = append(file.Profiles, sp)
	}
	data, err := json.MarshalIndent(file, "", "  ")
	if err != nil {
		return err
	}
	return atomicWriteFile(filepath.Join(s.dir, profilesFile), data, 0o600)
}

// sealSeal 用 AES-256-GCM 加密，输出 base64(nonce|ciphertext)。
func (s *Store) sealSeal(plain string) (string, error) {
	block, err := aes.NewCipher(s.key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	sealed := gcm.Seal(nil, nonce, []byte(plain), nil)
	return base64.StdEncoding.EncodeToString(append(nonce, sealed...)), nil
}

func (s *Store) sealOpen(encoded string) (string, error) {
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(s.key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(raw) < gcm.NonceSize() {
		return "", errors.New("sealed payload too short")
	}
	plain, err := gcm.Open(nil, raw[:gcm.NonceSize()], raw[gcm.NonceSize():], nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}

func newID() (string, error) {
	buf := make([]byte, 12)
	if _, err := io.ReadFull(rand.Reader, buf); err != nil {
		return "", err
	}
	return fmt.Sprintf("p_%s", base64.RawURLEncoding.EncodeToString(buf)), nil
}

// atomicWriteFile 先写临时文件再原子改名，避免半截文件损坏存储。
func atomicWriteFile(path string, data []byte, perm os.FileMode) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, perm); err != nil {
		return err
	}
	if err := os.Chmod(tmp, perm); err != nil {
		// Windows 上 0600 的语义有限，设置失败不阻断写入。
		_ = err
	}
	return os.Rename(tmp, path)
}
