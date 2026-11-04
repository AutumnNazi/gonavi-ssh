package transfer

import (
	"errors"
	"testing"

	"github.com/pkg/sftp"

	"gonavi-ssh/internal/sshclient"
)

// failingSftp 让重试启动的传输立刻失败：本用例只关心「中断的任务能重试」，
// 不需要真实 SFTP。
type failingSftp struct{}

func (failingSftp) Client(*sshclient.Conn) (*sftp.Client, error) {
	return nil, errors.New("no sftp in this test")
}

func interruptedFlag(task *Task) bool {
	task.mu.Lock()
	defer task.mu.Unlock()
	return task.interrupted
}

func cancelledStateOf(task *Task) State {
	task.mu.Lock()
	defer task.mu.Unlock()
	return task.cancelledState()
}

// 关窗清理把运行中/排队中的任务记为「已中断」：UI 才能把它和用户主动取消
// 区分开，并在重开窗口后提示续传。
func TestCloseAllMarksUnfinishedTasksInterrupted(t *testing.T) {
	m := NewManager(nil)
	runningCanceled, queuedCanceled, doneCanceled := false, false, false
	running := &Task{ID: "r", Direction: Download}
	running.state = Running
	running.cancel = func() { runningCanceled = true }
	queued := &Task{ID: "q", Direction: Upload}
	queued.state = Queued
	queued.cancel = func() { queuedCanceled = true }
	done := &Task{ID: "d", Direction: Download}
	done.state = Done
	done.cancel = func() { doneCanceled = true }
	for _, task := range []*Task{running, queued, done} {
		m.addTask(task)
	}

	m.CloseAll()

	if !runningCanceled || !queuedCanceled {
		t.Fatalf("unfinished tasks must be cancelled: running=%v queued=%v", runningCanceled, queuedCanceled)
	}
	if doneCanceled {
		t.Fatal("finished tasks must not be cancelled")
	}
	if !interruptedFlag(running) || !interruptedFlag(queued) {
		t.Fatal("cleanup must mark unfinished tasks as interrupted")
	}
	if interruptedFlag(done) {
		t.Fatal("finished tasks must not be marked interrupted")
	}
	if got := cancelledStateOf(running); got != Interrupted {
		t.Fatalf("running state=%s want %s", got, Interrupted)
	}
	if got := cancelledStateOf(queued); got != Interrupted {
		t.Fatalf("queued state=%s want %s", got, Interrupted)
	}
	if got := cancelledStateOf(done); got != Cancelled {
		t.Fatalf("done task must keep the plain cancelled state, got %s", got)
	}
}

// 用户点「取消」不带中断标记：仍然记 cancelled，UI 不该提示续传。
func TestUserCancelStaysCancelled(t *testing.T) {
	m := NewManager(nil)
	task := &Task{ID: "r", Direction: Download}
	task.state = Running
	task.cancel = func() {}
	m.addTask(task)

	if err := m.Cancel("r"); err != nil {
		t.Fatalf("cancel: %v", err)
	}
	if interruptedFlag(task) {
		t.Fatal("user cancel must not be recorded as an interruption")
	}
	if got := cancelledStateOf(task); got != Cancelled {
		t.Fatalf("state=%s want %s", got, Cancelled)
	}
}

// 被关窗中断的任务与失败/取消一样可以续传。
func TestRetryAcceptsInterruptedTask(t *testing.T) {
	m := NewManager(failingSftp{})
	task := &Task{ID: "x1", Direction: Download, RemotePath: "/remote/a", LocalPath: "local/a"}
	task.state = Interrupted
	m.addTask(task)

	id, err := m.Retry("x1", &sshclient.Conn{ID: "c1"}, func(string) bool { return true })
	if err != nil {
		t.Fatalf("retry interrupted: %v", err)
	}
	if id == "" || id == "x1" {
		t.Fatalf("retry must start a new task, got %q", id)
	}
}

// 路由层与任务层共用同一份可重试判据，防止两边各写一份状态清单后走偏。
func TestRetryableStates(t *testing.T) {
	for state, want := range map[State]bool{
		Failed: true, Cancelled: true, Interrupted: true,
		Queued: false, Running: false, Done: false,
	} {
		if got := Retryable(state); got != want {
			t.Errorf("Retryable(%s)=%v want %v", state, got, want)
		}
	}
}
