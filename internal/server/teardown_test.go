package server

import (
	"sync/atomic"
	"testing"
	"time"
)

// 清理步骤必须并行：关连接的网络收尾彼此无关，串行累加会把关窗流程拖长。
func TestRunTeardownRunsStepsInParallel(t *testing.T) {
	started := make(chan struct{}, 4)
	release := make(chan struct{})
	step := func() {
		started <- struct{}{}
		<-release
	}
	done := make(chan bool, 1)
	go func() { done <- runTeardown(3*time.Second, step, step, step, step) }()

	for i := 0; i < 4; i++ {
		select {
		case <-started:
		case <-time.After(time.Second):
			t.Fatalf("only %d steps started within the deadline: steps are serial", i)
		}
	}
	close(release)
	if !<-done {
		t.Fatal("teardown must report completion when every step finished in time")
	}
}

// 有步骤卡住时必须按期限返回：宿主在 teardown 返回前一直把窗口标记为
// closing，新窗口会被拒（plugin window is closing）。
func TestRunTeardownReturnsAtGraceWithAHangingStep(t *testing.T) {
	var started, finished int32
	release := make(chan struct{})
	hang := func() {
		atomic.AddInt32(&started, 1)
		<-release
		atomic.AddInt32(&finished, 1)
	}
	quick := func() { atomic.AddInt32(&started, 1); atomic.AddInt32(&finished, 1) }

	start := time.Now()
	completed := runTeardown(80*time.Millisecond, hang, quick, quick, quick)
	elapsed := time.Since(start)
	close(release)

	if completed {
		t.Fatal("teardown must report that the deadline was hit")
	}
	if elapsed > time.Second {
		t.Fatalf("teardown waited for the hanging step: %v", elapsed)
	}
	if got := atomic.LoadInt32(&started); got != 4 {
		t.Fatalf("every step must start even when one hangs: started=%d", got)
	}
}

// grace<=0 表示不限时（进程退出路径）：必须等全部步骤收尾，不能提前返回。
func TestRunTeardownWithoutGraceWaitsForEveryStep(t *testing.T) {
	var finished int32
	step := func() {
		time.Sleep(20 * time.Millisecond)
		atomic.AddInt32(&finished, 1)
	}
	if !runTeardown(0, step, step) {
		t.Fatal("grace<=0 must wait for completion")
	}
	if got := atomic.LoadInt32(&finished); got != 2 {
		t.Fatalf("finished=%d want 2", got)
	}
}

// 命令本身保持轻量：没有会话时立即返回，宿主才能马上放行重开窗口。
func TestSessionTeardownReturnsPromptlyWithoutSessions(t *testing.T) {
	app := newTestApp(t)
	start := time.Now()
	if _, err := invoke(t, app.Handlers()["session.teardown"], `{}`); err != nil {
		t.Fatalf("teardown: %v", err)
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("teardown of an idle plugin process is slow: %v", elapsed)
	}
}
