package server

import (
	"sync"
	"time"
)

// teardownGrace 关窗清理的等待上限。
//
// 宿主在 session.teardown 返回之前一直把这个插件窗口标记为 closing，期间
// 新窗口会被直接拒绝（"plugin window is closing"）。插件进程是多个窗口
// 共享的，关连接又都是网络往返，一次慢链路就能把「关窗后马上重开」堵在
// 这里。终端、传输、SSH 连接都是先在锁内清空状态表、再到锁外做网络收尾，
// 所以提前放行不会让新窗口看到旧会话；SFTP 客户端逐个 Close 再删表，收尾
// 本身很短。超期返回后剩下的收尾在后台继续跑完。
const teardownGrace = 500 * time.Millisecond

// runTeardown 并行执行清理步骤，最多等 grace 后返回是否在期限内全部完成。
// grace<=0 表示不限时（进程退出路径，必须等干净）。
func runTeardown(grace time.Duration, steps ...func()) bool {
	var wg sync.WaitGroup
	for _, step := range steps {
		wg.Add(1)
		go func(run func()) {
			defer wg.Done()
			run()
		}(step)
	}
	done := make(chan struct{})
	go func() {
		wg.Wait()
		close(done)
	}()
	if grace <= 0 {
		<-done
		return true
	}
	timer := time.NewTimer(grace)
	defer timer.Stop()
	select {
	case <-done:
		return true
	case <-timer.C:
		return false
	}
}

// closeAllSessions 返回四类插件级资源的清理步骤。彼此顺序无关：终端、传输、
// SFTP 客户端与 SSH 连接各自持有独立句柄，关掉一个不会让另一个的关闭出错。
func (a *App) closeAllSessions() []func() {
	return []func(){a.terms.CloseAll, a.transfers.CloseAll, a.sftp.CloseAll, a.conns.CloseAll}
}
