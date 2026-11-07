package server

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// repeatReader 产出 n 个字节但不预分配：上限是 64 MiB，用例没必要真占那么多内存。
type repeatReader struct {
	remaining int64
	chunk     byte
}

func (r *repeatReader) Read(p []byte) (int, error) {
	if r.remaining <= 0 {
		return 0, io.EOF
	}
	n := len(p)
	if int64(n) > r.remaining {
		n = int(r.remaining)
	}
	for i := 0; i < n; i++ {
		p[i] = r.chunk
	}
	r.remaining -= int64(n)
	return n, nil
}

func TestLocalNameForIsStableAndKeepsTheOriginalName(t *testing.T) {
	same := localNameFor("c1", "/etc/hosts", "hosts")
	if same != localNameFor("c1", "/etc/hosts", "hosts") {
		t.Fatalf("same remote path must map to the same local file")
	}
	if same == localNameFor("c2", "/etc/hosts", "hosts") {
		t.Fatalf("two connections must not share one local file: /etc/hosts exists on every machine")
	}
	if same == localNameFor("c1", "/etc/hostname", "hostname") {
		t.Fatalf("different remote paths must not collide")
	}
	if !strings.HasSuffix(same, "-hosts") {
		t.Fatalf("the original name must stay recognizable in the editor title bar, got %q", same)
	}
}

func TestLocalNameForStripsCharactersTheLocalFilesystemRejects(t *testing.T) {
	// 远端文件名可以带冒号、引号这些 Windows 上非法（或会被当成分隔符）的字符。
	nasty := localNameFor("c1", "/tmp/a", `we:ird*na?me"<>.txt`)
	if filepath.Base(nasty) != nasty {
		t.Fatalf("local name must be a single path segment, got %q", nasty)
	}
	if strings.ContainsAny(nasty, `/\:*?"<>|`) {
		t.Fatalf("local name must not keep separators or reserved characters, got %q", nasty)
	}
}

func TestLocalNameForFallsBackWhenTheRemoteNameIsUnusable(t *testing.T) {
	for _, name := range []string{"", ".", "..", "/"} {
		got := localNameFor("c1", "/tmp/x", name)
		if filepath.Base(got) != got || got == "." || got == ".." {
			t.Fatalf("name %q must still produce a usable local file, got %q", name, got)
		}
	}
}

func TestWriteOpenedFileLandsUnderThePluginDataDir(t *testing.T) {
	app := newTestApp(t)
	local, err := app.writeOpenedFile("c1", "/etc/hosts", "hosts", strings.NewReader("hello"))
	if err != nil {
		t.Fatalf("write opened file: %v", err)
	}
	if want := filepath.Join(app.dataDir, openExternalDir); filepath.Dir(local) != want {
		t.Fatalf("fetched file must land in %q, got %q", want, local)
	}
	got, err := os.ReadFile(local)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(got) != "hello" {
		t.Fatalf("content mismatch: %q", got)
	}
}

func TestWriteOpenedFileRejectsOversizeAndLeavesNoHalfFile(t *testing.T) {
	app := newTestApp(t)
	src := &repeatReader{remaining: openExternalMaxBytes + 1, chunk: 'x'}
	if _, err := app.writeOpenedFile("c1", "/var/log/huge.log", "huge.log", src); err == nil {
		t.Fatalf("a file over the cap must be rejected")
	}
	// 半截文件不能留在盘上：用户点上传就把残缺内容推回远端了。
	entries, err := os.ReadDir(filepath.Join(app.dataDir, openExternalDir))
	if err != nil && !os.IsNotExist(err) {
		t.Fatalf("read opened dir: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("oversize fetch must clean up after itself, found %v", entries)
	}
}

func TestOpenExternalRejectsAnUnknownConnection(t *testing.T) {
	app := newTestApp(t)
	if _, err := app.Handlers()["sftp.openExternal"](context.Background(), json.RawMessage(
		`{"connectionId":"missing","path":"/etc/hosts"}`)); err == nil {
		t.Fatalf("an unknown connection must be rejected before touching the filesystem")
	}
}
