package sftpops

import (
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"golang.org/x/crypto/ssh"

	"gonavi-ssh/internal/sshclient"
)

// 这组用例锁住的是一条不变量：SFTP 管理器的锁只保护「连接表」，
// 建通道与关通道这类网络动作必须在锁外做。否则一条假死链路能把
// 整个插件的文件操作与传输启动一起冻住（锁是插件进程一份的）。

// probeTimeout 判定「被拖住」的时限：健康连接上一次取客户端的耗时是
// 一次 map 查询，2 秒足够宽裕，卡住的实现会一直等到它自己放弃。
const probeTimeout = 2 * time.Second

// mintPipeClient 造一个跑在内存管道上的可用 SFTP 客户端（对端是真实请求服务器）。
// wrap 非空时套在管道上，用来观测或卡住关闭动作。
func mintPipeClient(t *testing.T, wrap func(net.Conn) net.Conn) *sftp.Client {
	t.Helper()
	serverPipe, clientPipe := net.Pipe()
	server := sftp.NewRequestServer(serverPipe, sftp.InMemHandler())
	done := make(chan error, 1)
	go func() { done <- server.Serve() }()
	var wire net.Conn = clientPipe
	if wrap != nil {
		wire = wrap(clientPipe)
	}
	client, err := sftp.NewClientPipe(wire, wire)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close(); _ = server.Close(); <-done })
	return client
}

// recordClose 记录关闭动作（不阻塞），用于断言「多建出来的通道被关掉了」。
type recordClose struct {
	net.Conn
	closed atomic.Bool
}

func (r *recordClose) Close() error {
	r.closed.Store(true)
	return r.Conn.Close()
}

// newLiveClient 造一个可用客户端并预置进连接表，模拟已经建好的连接。
func newLiveClient(t *testing.T, manager *Manager, id string) (*sshclient.Conn, *sftp.Client) {
	t.Helper()
	client := mintPipeClient(t, nil)
	conn := &sshclient.Conn{ID: id}
	manager.clients[id] = client
	return conn, client
}

// stallClose 让底层收尾卡住不返回：模拟服务器消失、防火墙黑洞这类假死链路。
type stallClose struct {
	net.Conn
	entered chan struct{}
	release chan struct{}
	once    sync.Once
}

func (s *stallClose) Close() error {
	s.once.Do(func() { close(s.entered) })
	<-s.release
	return s.Conn.Close()
}

// newStallingClient 造一个「可用但关不掉」的 SFTP 客户端并预置进连接表。
func newStallingClient(t *testing.T, manager *Manager, id string) (*sshclient.Conn, *stallClose, func()) {
	t.Helper()
	serverPipe, clientPipe := net.Pipe()
	server := sftp.NewRequestServer(serverPipe, sftp.InMemHandler())
	done := make(chan error, 1)
	go func() { done <- server.Serve() }()
	stall := &stallClose{Conn: clientPipe, entered: make(chan struct{}), release: make(chan struct{})}
	client, err := sftp.NewClientPipe(stall, stall)
	if err != nil {
		t.Fatal(err)
	}
	conn := &sshclient.Conn{ID: id}
	manager.clients[id] = client
	release := sync.OnceFunc(func() { close(stall.release) })
	t.Cleanup(func() { release(); _ = client.Close(); _ = server.Close(); <-done })
	return conn, stall, release
}

// TestConcurrentChannelOpenKeepsStoredClient 覆盖放锁建通道带来的新分支：
// 放锁期间另一个调用可能已经把通道存好了，这时必须交回表里那条并关掉自己
// 多建的，否则同一连接挂着两条通道，或把已关闭的通道交给调用方。
func TestConcurrentChannelOpenKeepsStoredClient(t *testing.T) {
	manager := NewManager()
	conn := &sshclient.Conn{ID: "a"}
	stored := mintPipeClient(t, nil)
	loserWire := &recordClose{}
	loser := mintPipeClient(t, func(c net.Conn) net.Conn {
		loserWire.Conn = c
		return loserWire
	})
	previous := newSftpClient
	newSftpClient = func(*ssh.Client) (*sftp.Client, error) {
		// 模拟并发的另一个调用在本次建通道期间先存好了自己的通道。
		manager.clients[conn.ID] = stored
		return loser, nil
	}
	t.Cleanup(func() { newSftpClient = previous })

	got, err := manager.Client(conn)
	if err != nil {
		t.Fatal(err)
	}
	if got != stored {
		t.Fatal("并发下必须交回连接表里已有的通道")
	}
	if !loserWire.closed.Load() {
		t.Fatal("多建出来的通道必须关掉")
	}
	if manager.clients[conn.ID] != stored {
		t.Fatal("连接表里的通道被多建的那条覆盖了")
	}
}

// assertClientAvailable 断言健康连接仍能立刻拿到客户端。
// 卡住的实现在这里超时——它正握着锁做网络动作。
func assertClientAvailable(t *testing.T, manager *Manager, conn *sshclient.Conn) {
	t.Helper()
	done := make(chan error, 1)
	go func() {
		_, err := manager.Client(conn)
		done <- err
	}()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("健康连接取不到客户端: %v", err)
		}
	case <-time.After(probeTimeout):
		t.Fatal("收尾卡住期间其他连接的 SFTP 操作被拖住：锁里做了网络动作")
	}
}

func TestClosingOneConnectionDoesNotBlockOtherConnections(t *testing.T) {
	manager := NewManager()
	connB, _ := newLiveClient(t, manager, "b")
	connA, stall, release := newStallingClient(t, manager, "a")

	finished := make(chan struct{})
	go func() {
		defer close(finished)
		manager.Close(connA.ID)
	}()

	select { // 先确认关闭动作真的进了卡住的收尾，否则断言等于没测
	case <-stall.entered:
	case <-time.After(probeTimeout):
		release()
		t.Fatal("关闭动作没有进入收尾")
	}
	assertClientAvailable(t, manager, connB)

	release()
	select {
	case <-finished:
	case <-time.After(probeTimeout):
		t.Fatal("放行收尾后关闭动作仍未返回")
	}
}

func TestOpeningOneChannelDoesNotBlockOtherConnections(t *testing.T) {
	manager := NewManager()
	connB, _ := newLiveClient(t, manager, "b")
	// a 底部没有真实 ssh 客户端：打开动作由替身接管，不会真去建通道。
	connA := &sshclient.Conn{ID: "a"}

	entered := make(chan struct{})
	gate := make(chan struct{})
	var opened sync.Once
	previous := newSftpClient
	newSftpClient = func(*ssh.Client) (*sftp.Client, error) {
		opened.Do(func() { close(entered) })
		<-gate
		return nil, errors.New("通道打开在测试里被卡住")
	}
	release := sync.OnceFunc(func() { close(gate) })
	t.Cleanup(func() { release(); newSftpClient = previous })

	finished := make(chan struct{})
	go func() {
		defer close(finished)
		_, _ = manager.Client(connA)
	}()

	select {
	case <-entered:
	case <-time.After(probeTimeout):
		t.Fatal("打开动作没有开始")
	}
	assertClientAvailable(t, manager, connB)

	release()
	select {
	case <-finished:
	case <-time.After(probeTimeout):
		t.Fatal("放行打开动作后仍未返回")
	}
}
