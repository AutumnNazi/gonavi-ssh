// Package sshclient 管理 SSH 连接生命周期。连接是两段式的：
// conn.open 立即返回 pending 连接 ID，拨号（含跳板链与交互认证）在后台
// 进行；需要键盘交互（TOTP 等）时状态变为 needInput，UI 用 conn.answer
// 提交答案后继续。conn.status 汇报 pending 与 ready 连接的全貌。
package sshclient

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"golang.org/x/crypto/ssh"

	"gonavi-ssh/internal/profile"
)

const (
	dialTimeout             = 15 * time.Second
	keepaliveEvery          = 30 * time.Second
	keepaliveFails          = 3
	keepaliveRequestTimeout = 20 * time.Second
	interactiveTimeout      = 120 * time.Second // 留给用户输入动态码的时间
	pendingTTL              = 10 * time.Minute  // failed pending 的保留时长
)

// ConnState 是连接（含 pending 阶段）的状态。
type ConnState string

const (
	StateConnecting ConnState = "connecting"
	StateNeedInput  ConnState = "needInput"
	StateReady      ConnState = "ready"
	StateFailed     ConnState = "failed"
	StateCancelled  ConnState = "cancelled"
)

// Challenge 是一次键盘交互提问（可能来自主目标或某一跳）。
type Challenge struct {
	Stage       string   `json:"stage"` // "main" 或 "jump1"/"jump2"/...
	Name        string   `json:"name"`
	Instruction string   `json:"instruction,omitempty"`
	Prompts     []string `json:"prompts"`
	Echo        []bool   `json:"echo,omitempty"`
}

// Conn 是一条存活的 SSH 连接。Client 可并发开多个 session/channel。
type Conn struct {
	ID        string
	ProfileID string
	Addr      string
	client    *ssh.Client
	// via 是跳板链上各跳的客户端（不含最终 client）；Close 时逆序关闭。
	via      []*ssh.Client
	openedAt time.Time

	lastActive atomic.Int64
	dead       atomic.Bool
	done       chan struct{}
	closeOnce  sync.Once
}

// Client 暴露底层 ssh.Client，供 terminal/sftp 开 channel。
func (c *Conn) Client() *ssh.Client { return c.client }

func (c *Conn) touch() { c.lastActive.Store(time.Now().UnixNano()) }

// Alive 报告连接是否仍可用。
func (c *Conn) Alive() bool { return !c.dead.Load() }

// Close 幂等关闭连接：最终连接先关，跳板链逆序跟进，防止中间跳泄漏。
func (c *Conn) Close() {
	c.closeOnce.Do(func() {
		c.dead.Store(true)
		close(c.done)
		_ = c.client.Close()
		for i := len(c.via) - 1; i >= 0; i-- {
			_ = c.via[i].Close()
		}
	})
}

// Pending 是一次进行中的两段式连接。
type Pending struct {
	ID        string
	ProfileID string
	startedAt time.Time

	ctx    context.Context
	cancel context.CancelFunc

	mu        sync.Mutex
	state     ConnState
	challenge *Challenge
	err       error
	conn      *Conn
	answerCh  chan []string // 缓冲 1：UI 提交一次答案

	done chan struct{} // 拨号 goroutine 结束
}

// Status 描述 pending 与 ready 连接的统一视图。
type Status struct {
	ConnectionID string     `json:"connectionId"`
	ProfileID    string     `json:"profileId"`
	Addr         string     `json:"addr"`
	State        ConnState  `json:"state"`
	Alive        bool       `json:"alive"`
	Error        string     `json:"error,omitempty"`
	Challenge    *Challenge `json:"challenge,omitempty"`
	OpenedAt     time.Time  `json:"openedAt,omitempty"`
	StartedAt    time.Time  `json:"startedAt,omitempty"`
	LastActiveMs int64      `json:"lastActiveMs,omitempty"`
}

func (p *Pending) snapshot() Status {
	p.mu.Lock()
	defer p.mu.Unlock()
	st := Status{
		ConnectionID: p.ID, ProfileID: p.ProfileID,
		State: p.state, StartedAt: p.startedAt,
	}
	if p.challenge != nil {
		c := *p.challenge
		st.Challenge = &c
	}
	if p.err != nil {
		st.Error = p.err.Error()
	}
	if p.conn != nil {
		st.Addr = p.conn.Addr
		st.Alive = p.conn.Alive()
		st.OpenedAt = p.conn.openedAt
		st.LastActiveMs = time.Since(time.Unix(0, p.conn.lastActive.Load())).Milliseconds()
	}
	return st
}

func (p *Pending) setState(s ConnState, err error, challenge *Challenge, conn *Conn) {
	p.mu.Lock()
	p.state = s
	p.err = err
	p.challenge = challenge
	if conn != nil {
		p.conn = conn
	}
	p.mu.Unlock()
}

// Manager 维护 pending + ready 连接。
type Manager struct {
	dataDir string
	hosts   *knownHosts

	// onDead 在连接因 keepalive 失败等原因自然死亡时回调（如清理
	// 绑定该连接的 sftp client）。注册发生在启动期，运行期只读。
	onDead atomic.Pointer[func(string)]

	mu               sync.Mutex
	conns            map[string]*Conn
	byProfile        map[string]*Conn
	pending          map[string]*Pending
	byProfilePending map[string]*Pending
}

// NewManager 初始化连接管理器；dataDir 存放 known_hosts。
func NewManager(dataDir string) (*Manager, error) {
	hosts, err := loadKnownHosts(dataDir)
	if err != nil {
		return nil, err
	}
	return &Manager{
		dataDir:          dataDir,
		hosts:            hosts,
		conns:            map[string]*Conn{},
		byProfile:        map[string]*Conn{},
		pending:          map[string]*Pending{},
		byProfilePending: map[string]*Pending{},
	}, nil
}

// OpenBegin 开始（或复用）一次连接：立即返回连接 ID。
// 返回的 state 可能直接是 ready（复用）或 connecting（新拨号）。
func (m *Manager) OpenBegin(p profile.Profile) Status {
	m.mu.Lock()
	if conn, ok := m.byProfile[p.ID]; ok && conn.Alive() {
		id := conn.ID
		m.mu.Unlock()
		conn.touch()
		return Status{
			ConnectionID: id, ProfileID: p.ID, Addr: conn.Addr,
			State: StateReady, Alive: true, OpenedAt: conn.openedAt,
		}
	}
	if pend, ok := m.byProfilePending[p.ID]; ok && pend.ctx.Err() == nil {
		m.mu.Unlock()
		return pend.snapshot()
	}

	id, err := newConnectionID()
	if err != nil {
		return Status{State: StateFailed, Error: "generate id: " + err.Error()}
	}
	ctx, cancel := context.WithCancel(context.Background())
	pend := &Pending{
		ID: id, ProfileID: p.ID, startedAt: time.Now(),
		ctx: ctx, cancel: cancel,
		answerCh: make(chan []string, 1),
		done:     make(chan struct{}),
	}
	pend.setState(StateConnecting, nil, nil, nil)
	m.pending[id] = pend
	m.byProfilePending[p.ID] = pend
	m.mu.Unlock()

	go m.runDial(pend, p)
	return pend.snapshot()
}

// runDial 执行完整拨号链并收敛 pending 状态。
func (m *Manager) runDial(pend *Pending, p profile.Profile) {
	defer close(pend.done)
	client, viaChain, err := m.dialChain(pend.ctx, p, m.interactiveFor(pend))
	m.mu.Lock()
	delete(m.byProfilePending, pend.ProfileID)
	if err != nil {
		if pend.ctx.Err() != nil {
			pend.setState(StateCancelled, errors.New("cancelled by user"), nil, nil)
			// 取消的 pending 立即摘除；failed 的短暂保留供 UI 读错误。
			delete(m.pending, pend.ID)
		} else {
			pend.setState(StateFailed, sanitizeDialError(err), nil, nil)
			time.AfterFunc(pendingTTL, func() { m.dropPending(pend.ID) })
		}
		m.mu.Unlock()
		return
	}
	conn := &Conn{
		ID: pend.ID, ProfileID: p.ID,
		Addr: joinAddr(p.Host, p.Port), client: client, via: viaChain,
		openedAt: time.Now(), done: make(chan struct{}),
	}
	m.conns[conn.ID] = conn
	m.byProfile[conn.ProfileID] = conn
	// 成功后 pending 条目立即摘除（ready 状态由 conns 提供），
	// 否则 conn.status 会返回重复记录。
	delete(m.pending, pend.ID)
	pend.setState(StateReady, nil, nil, conn)
	m.mu.Unlock()
	go m.keepalive(conn)
}

// interactiveFor 构造把键盘交互提问转发给 UI 的回调。
func (m *Manager) interactiveFor(pend *Pending) interactiveFunc {
	return func(stage string) ssh.KeyboardInteractiveChallenge {
		return func(name, instruction string, questions []string, echos []bool) ([]string, error) {
			pend.setState(StateNeedInput, nil, &Challenge{
				Stage: stage, Name: name, Instruction: instruction,
				Prompts: questions, Echo: echos,
			}, nil)
			defer pend.setState(StateConnecting, nil, nil, nil)
			select {
			case ans := <-pend.answerCh:
				return ans, nil
			case <-pend.ctx.Done():
				return nil, pend.ctx.Err()
			case <-time.After(interactiveTimeout):
				return nil, errors.New("interactive prompt timed out")
			}
		}
	}
}

// Answer 提交交互答案；仅在 needInput 状态有效。
func (m *Manager) Answer(connectionID string, answers []string) error {
	m.mu.Lock()
	pend, ok := m.pending[connectionID]
	m.mu.Unlock()
	if !ok {
		return errors.New("connection not found")
	}
	pend.mu.Lock()
	state := pend.state
	pend.mu.Unlock()
	if state != StateNeedInput {
		return fmt.Errorf("connection is not waiting for input (state %s)", state)
	}
	select {
	case pend.answerCh <- answers:
		return nil
	default:
		return errors.New("an answer is already pending")
	}
}

// CancelPending 取消进行中的连接。等待拨号收敛有上限：握手已带
// deadline，正常必能返回；极端卡死时不再无限等，避免命令本身挂死。
func (m *Manager) CancelPending(connectionID string) {
	m.mu.Lock()
	pend, ok := m.pending[connectionID]
	m.mu.Unlock()
	if !ok {
		return
	}
	pend.cancel()
	select {
	case <-pend.done:
	case <-time.After(5 * time.Second):
	}
}

// dropPending 只移除登记条目；拨号流程自身已收敛状态。
func (m *Manager) dropPending(id string) {
	m.mu.Lock()
	delete(m.pending, id)
	m.mu.Unlock()
}

// dialChain 经跳板链拨号：先逐跳建立跳板客户端，最后经最后一跳连到目标。
// 每一跳独立认证、独立 TOFU（按逻辑地址记录，而非隧道地址）。
// 失败时已建立的跳板链由调用方关闭（防泄漏）；成功时随 Conn.via 生命周期管理。
func (m *Manager) dialChain(ctx context.Context, p profile.Profile, interactive interactiveFunc) (*ssh.Client, []*ssh.Client, error) {
	var chain []*ssh.Client
	cleanup := func() {
		for i := len(chain) - 1; i >= 0; i-- {
			_ = chain[i].Close()
		}
	}
	for i, j := range p.Jumps {
		stage := fmt.Sprintf("jump%d", i+1)
		hop, err := m.dialHop(ctx, dialTarget{
			host: j.Host, port: j.Port,
			creds: creds{
				User: j.User, AuthMethod: j.AuthMethod, KeyPath: j.KeyPath,
				Password: j.Password, Passphrase: j.Passphrase,
			},
			stage: stage, via: lastOf(chain),
		}, interactive)
		if err != nil {
			cleanup()
			return nil, nil, fmt.Errorf("%s: %w", stage, err)
		}
		chain = append(chain, hop)
	}
	final, err := m.dialHop(ctx, dialTarget{
		host: p.Host, port: p.Port,
		creds: creds{
			User: p.User, AuthMethod: p.AuthMethod, KeyPath: p.KeyPath,
			Password: p.Password, Passphrase: p.Passphrase,
		},
		stage: "main", via: lastOf(chain),
	}, interactive)
	if err != nil {
		cleanup()
		return nil, nil, err
	}
	return final, chain, nil
}

func lastOf(chain []*ssh.Client) *ssh.Client {
	if len(chain) == 0 {
		return nil
	}
	return chain[len(chain)-1]
}

// dialTarget 是单跳拨号参数。
type dialTarget struct {
	host  string
	port  int
	creds creds
	stage string
	via   *ssh.Client // nil 表示直接 TCP
}

// dialHop 拨通一跳并返回客户端；via 非空时经由上层客户端的转发通道。
func (m *Manager) dialHop(ctx context.Context, t dialTarget, interactive interactiveFunc) (*ssh.Client, error) {
	addr := joinAddr(t.host, t.port)
	methods, err := buildAuthMethods(t.creds, interactive, t.stage)
	if err != nil {
		return nil, err
	}
	config := &ssh.ClientConfig{
		User:            strings.TrimSpace(t.creds.User),
		Auth:            methods,
		HostKeyCallback: m.hosts.callbackFor(addr),
		Timeout:         dialTimeout,
	}
	var netConn net.Conn
	if t.via == nil {
		d := net.Dialer{Timeout: dialTimeout}
		netConn, err = d.DialContext(ctx, "tcp", addr)
	} else {
		// 跳板路径没有 DialContext 等价物：拨号放后台，ctx 取消时
		// 丢弃并关闭结果连接，避免调用方无限等待。
		type dialResult struct {
			c net.Conn
			e error
		}
		ch := make(chan dialResult, 1)
		go func() { c, e := t.via.Dial("tcp", addr); ch <- dialResult{c, e} }()
		select {
		case r := <-ch:
			netConn, err = r.c, r.e
		case <-ctx.Done():
			go func() {
				if r := <-ch; r.c != nil {
					_ = r.c.Close()
				}
			}()
			return nil, ctx.Err()
		}
	}
	if err != nil {
		return nil, fmt.Errorf("dial %s: %w", addr, err)
	}
	// 握手看门狗：对端接受 TCP 但不握手时不能永久阻塞。交互认证
	// （OTP/TOTP）期间放宽到 dialTimeout+interactiveTimeout，避免用户
	// 输入超过 15s 就被网络超时打断；交互结束恢复为握手超时。
	hsTimer := time.AfterFunc(dialTimeout, func() { _ = netConn.Close() })
	defer hsTimer.Stop()
	stopCtx := context.AfterFunc(ctx, func() { _ = netConn.Close() })
	defer stopCtx()

	if interactive != nil {
		wrapped := func(stage string) ssh.KeyboardInteractiveChallenge {
			inner := interactive(stage)
			return func(name, instruction string, questions []string, echos []bool) ([]string, error) {
				hsTimer.Reset(dialTimeout + interactiveTimeout)
				defer hsTimer.Reset(dialTimeout)
				return inner(name, instruction, questions, echos)
			}
		}
		methods, err = buildAuthMethods(t.creds, wrapped, t.stage)
		if err != nil {
			return nil, err
		}
		config.Auth = methods
	}

	sshConn, chans, reqs, err := ssh.NewClientConn(netConn, addr, config)
	if err != nil {
		_ = netConn.Close()
		return nil, err
	}
	return ssh.NewClient(sshConn, chans, reqs), nil
}

// OnDead 注册连接自然死亡（keepalive 失败）的回调；启动期调用一次。
func (m *Manager) OnDead(fn func(connectionID string)) {
	m.onDead.Store(&fn)
}

// keepalive 周期性探测连接；单次探测有超时（远端不回包时不无限
// 挂起），连续失败即关闭，让上层得到明确的死亡信号。
func (m *Manager) keepalive(conn *Conn) {
	fails := 0
	ticker := time.NewTicker(keepaliveEvery)
	defer ticker.Stop()
	for {
		select {
		case <-conn.done:
			return
		case <-ticker.C:
			if m.keepaliveProbe(conn) {
				fails = 0
				continue
			}
			fails++
			if fails >= keepaliveFails {
				conn.dead.Store(true)
				m.drop(conn)
				// 联动清理绑定该连接的资源（如 sftp client）。
				if fn := m.onDead.Load(); fn != nil {
					go (*fn)(conn.ID)
				}
				conn.Close()
				return
			}
		}
	}
}

// keepaliveProbe 发送一次探活并等待回应，最多 keepaliveRequestTimeout。
// SendRequest 无法取消：超时后探测 goroutine 会在连接关闭时返回，
// 结果写入带缓冲 channel 不会阻塞。
func (m *Manager) keepaliveProbe(conn *Conn) bool {
	result := make(chan error, 1)
	go func() {
		_, _, err := conn.client.SendRequest("keepalive@openssh.com", true, nil)
		result <- err
	}()
	select {
	case err := <-result:
		return err == nil
	case <-time.After(keepaliveRequestTimeout):
		return false
	case <-conn.done:
		return false
	}
}

// drop 把失效连接从索引摘除。
func (m *Manager) drop(conn *Conn) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if c, ok := m.byProfile[conn.ProfileID]; ok && c == conn {
		delete(m.byProfile, conn.ProfileID)
	}
	delete(m.conns, conn.ID)
}

// KnownHosts 返回全部已信任主机（地址+指纹），供审计与管理。
func (m *Manager) KnownHosts() []KnownHostEntry { return m.hosts.List() }

// RemoveKnownHost 删除一条主机信任记录（主机重装/换机后重录指纹用）。
func (m *Manager) RemoveKnownHost(addr string) bool { return m.hosts.Remove(addr) }

// Get 按 connectionId 查找存活连接。
func (m *Manager) Get(id string) (*Conn, bool) {
	m.mu.Lock()
	conn, ok := m.conns[id]
	m.mu.Unlock()
	if !ok || !conn.Alive() {
		return nil, false
	}
	return conn, true
}

// CloseByID 关闭连接或取消 pending；不存在不是错误。
func (m *Manager) CloseByID(id string) {
	m.mu.Lock()
	conn, hasConn := m.conns[id]
	pend, hasPend := m.pending[id]
	m.mu.Unlock()
	if hasConn {
		m.drop(conn)
		conn.Close()
	}
	if hasPend {
		pend.cancel()
	}
}

// CloseAll 关闭全部连接与 pending，用于进程退出前的清理。
func (m *Manager) CloseAll() {
	m.mu.Lock()
	conns := make([]*Conn, 0, len(m.conns))
	for _, c := range m.conns {
		conns = append(conns, c)
	}
	pends := make([]*Pending, 0, len(m.pending))
	for _, p := range m.pending {
		pends = append(pends, p)
	}
	m.conns = map[string]*Conn{}
	m.byProfile = map[string]*Conn{}
	m.pending = map[string]*Pending{}
	m.byProfilePending = map[string]*Pending{}
	m.mu.Unlock()
	for _, c := range conns {
		c.Close()
	}
	for _, p := range pends {
		p.cancel()
	}
}

// Status 返回全部连接概要（pending + ready）；id 非空时只返回该连接。
func (m *Manager) Status(id string) []Status {
	m.mu.Lock()
	var out []Status
	if id != "" {
		if c, ok := m.conns[id]; ok {
			out = append(out, readyStatus(c))
		}
		if p, ok := m.pending[id]; ok {
			out = append(out, p.snapshot())
		}
		m.mu.Unlock()
		return out
	}
	for _, c := range m.conns {
		out = append(out, readyStatus(c))
	}
	for _, p := range m.pending {
		out = append(out, p.snapshot())
	}
	m.mu.Unlock()
	return out
}

func readyStatus(c *Conn) Status {
	return Status{
		ConnectionID: c.ID, ProfileID: c.ProfileID, Addr: c.Addr,
		State: StateReady, Alive: c.Alive(), OpenedAt: c.openedAt,
		LastActiveMs: time.Since(time.Unix(0, c.lastActive.Load())).Milliseconds(),
	}
}

// DialInfo 是一次连通性测试的结果。
type DialInfo struct {
	Fingerprint   string `json:"fingerprint"`
	ServerVersion string `json:"serverVersion"`
}

// TestDial 只验证档案可连通，返回主机指纹与服务器版本（如 OpenSSH_9.6p1），
// 不保留连接；不交互（键盘交互回空答案，适合无人值守测试）。
func (m *Manager) TestDial(p profile.Profile) (DialInfo, error) {
	ctx, cancel := context.WithTimeout(context.Background(), dialTimeout+5*time.Second)
	defer cancel()
	client, chain, err := m.dialChain(ctx, p, nil)
	if err != nil {
		return DialInfo{}, err
	}
	info := DialInfo{
		Fingerprint:   m.hosts.Fingerprint(joinAddr(p.Host, p.Port)),
		ServerVersion: strings.TrimPrefix(string(client.ServerVersion()), "SSH-2.0-"),
	}
	_ = client.Close()
	for i := len(chain) - 1; i >= 0; i-- {
		_ = chain[i].Close()
	}
	return info, nil
}

func joinAddr(host string, port int) string {
	if port == 0 {
		port = 22
	}
	return net.JoinHostPort(strings.TrimSpace(host), strconv.Itoa(port))
}

func newConnectionID() (string, error) {
	buf := make([]byte, 12)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return "c_" + base64.RawURLEncoding.EncodeToString(buf), nil
}

// sanitizeDialError 去掉拨号错误里可能夹带的认证细节，统一为安全描述。
func sanitizeDialError(err error) error {
	if err != nil && strings.Contains(err.Error(), "unable to authenticate") {
		return errors.New("authentication failed for the configured auth method")
	}
	return err
}
