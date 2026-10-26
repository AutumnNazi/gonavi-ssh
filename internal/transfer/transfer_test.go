package transfer

import (
	"bytes"
	"context"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type progressRecorder struct {
	mu     sync.Mutex
	offset int64
	task   Task
}

// copyWithProgress 进度推进与取消传播（不依赖真实 sftp）。
func TestCopyWithProgress(t *testing.T) {
	var task Task
	task.mu.Lock()
	task.state = Running
	task.mu.Unlock()
	src := bytes.NewReader(bytes.Repeat([]byte("a"), 1024*1024))
	var dst bytes.Buffer
	err := copyWithProgress(context.Background(), &dst, src, &task, 0)
	if err != nil {
		t.Fatalf("copy: %v", err)
	}
	if dst.Len() != 1024*1024 {
		t.Fatalf("written %d", dst.Len())
	}
	task.mu.Lock()
	done := task.bytesDone
	task.mu.Unlock()
	if done != 1024*1024 {
		t.Fatalf("bytesDone %d", done)
	}
}

// ctx 取消时拷贝立即返回错误。
func TestCopyCancel(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // 先取消
	var task Task
	err := copyWithProgress(ctx, &bytes.Buffer{}, strings.NewReader("data"), &task, 0)
	if err == nil {
		t.Fatal("expected cancel error")
	}
}

// 断点元数据序列化往返（绑定来源路径/大小/mtime）。
func TestPartMetaRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "x.part.meta")
	meta := partMeta{Host: "p1@10.0.0.5:22", SourcePath: "/root/a.log", Size: 1024, MTime: 1700000000}
	if err := savePartMeta(path, meta); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, err := loadPartMeta(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if got != meta {
		t.Fatalf("got %+v want %+v", got, meta)
	}
}
