package transfer

import (
	"context"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/pkg/sftp"

	"gonavi-ssh/internal/sshclient"
)

type permissionFixture struct {
	sftp.Handlers
	mu           sync.Mutex
	modes        map[string]os.FileMode
	rejectChmod  bool
	rejectStat   bool
	rejectWrite  bool
	rejectRemove bool
	cancelWrite  context.CancelFunc
	writes       int
	renames      int
}

func (f *permissionFixture) OpenFile(r *sftp.Request) (sftp.WriterAtReaderAt, error) {
	rw, err := f.Handlers.FilePut.(sftp.OpenFileWriter).OpenFile(r)
	if err != nil {
		return nil, err
	}
	f.mu.Lock()
	if _, ok := f.modes[r.Filepath]; !ok {
		f.modes[r.Filepath] = 0o644
	}
	f.mu.Unlock()
	return &permissionWriter{WriterAtReaderAt: rw, fixture: f}, nil
}

func (f *permissionFixture) Filewrite(r *sftp.Request) (io.WriterAt, error) { return f.OpenFile(r) }

func (f *permissionFixture) Filecmd(r *sftp.Request) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Method == "Remove" && f.rejectRemove {
		return sftp.ErrSSHFxPermissionDenied
	}
	if r.Method == "Setstat" && r.AttrFlags().Permissions {
		if f.rejectChmod {
			return sftp.ErrSSHFxPermissionDenied
		}
		f.modes[r.Filepath] = r.Attributes().FileMode().Perm()
		return nil
	}
	if r.Method == "Rename" || r.Method == "PosixRename" {
		f.renames++
	}
	var err error
	if r.Method == "PosixRename" {
		err = f.Handlers.FileCmd.(sftp.PosixRenameFileCmder).PosixRename(r)
	} else {
		err = f.Handlers.FileCmd.Filecmd(r)
	}
	if err == nil {
		if r.Method == "Rename" || r.Method == "PosixRename" {
			f.modes[r.Target] = f.modes[r.Filepath]
			delete(f.modes, r.Filepath)
		}
		if r.Method == "Remove" {
			delete(f.modes, r.Filepath)
		}
	}
	return err
}

func (f *permissionFixture) PosixRename(r *sftp.Request) error { return f.Filecmd(r) }

func (f *permissionFixture) Filelist(r *sftp.Request) (sftp.ListerAt, error) {
	f.mu.Lock()
	reject := f.rejectStat && r.Method == "Stat" && r.Filepath == "/target"
	f.mu.Unlock()
	if reject {
		return nil, sftp.ErrSSHFxPermissionDenied
	}
	ls, err := f.Handlers.FileList.Filelist(r)
	if err != nil {
		return nil, err
	}
	f.mu.Lock()
	mode, ok := f.modes[r.Filepath]
	f.mu.Unlock()
	if r.Method == "Stat" && ok {
		return permissionLister{ListerAt: ls, mode: mode}, nil
	}
	return ls, nil
}

type permissionWriter struct {
	sftp.WriterAtReaderAt
	fixture *permissionFixture
}

func (w *permissionWriter) WriteAt(p []byte, off int64) (int, error) {
	w.fixture.mu.Lock()
	w.fixture.writes++
	reject := w.fixture.rejectWrite
	cancel := w.fixture.cancelWrite
	w.fixture.mu.Unlock()
	if reject {
		return 0, sftp.ErrSSHFxFailure
	}
	if cancel != nil {
		cancel()
	}
	return w.WriterAtReaderAt.WriteAt(p, off)
}

type permissionInfo struct {
	os.FileInfo
	mode os.FileMode
}

func (i permissionInfo) Mode() os.FileMode { return i.mode }

type permissionLister struct {
	sftp.ListerAt
	mode os.FileMode
}

func (l permissionLister) ListAt(dst []os.FileInfo, off int64) (int, error) {
	n, err := l.ListerAt.ListAt(dst, off)
	for i := 0; i < n; i++ {
		dst[i] = permissionInfo{FileInfo: dst[i], mode: l.mode}
	}
	return n, err
}

func newPermissionFixture(t *testing.T) (*Manager, *sshclient.Conn, *sftp.Client, *permissionFixture) {
	t.Helper()
	f := &permissionFixture{Handlers: sftp.InMemHandler(), modes: make(map[string]os.FileMode)}
	serverPipe, clientPipe := net.Pipe()
	server := sftp.NewRequestServer(serverPipe, sftp.Handlers{FileGet: f.Handlers.FileGet, FilePut: f, FileCmd: f, FileList: f})
	done := make(chan error, 1)
	go func() { done <- server.Serve() }()
	client, err := sftp.NewClientPipe(clientPipe, clientPipe)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close(); server.Close(); <-done })
	conn := &sshclient.Conn{ID: "fixture"}
	manager := NewManager(fixtureClient{client: client})

	return manager, conn, client, f
}

func seedPermissionFile(t *testing.T, client *sftp.Client, path, content string, mode os.FileMode) {
	t.Helper()
	file, err := client.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte(content)); err != nil {
		t.Fatal(err)
	}
	if err := file.Chmod(mode); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

func TestTransfersPreservePermissionsAndCleanTemps(t *testing.T) {
	for _, remote := range []bool{false, true} {
		for _, mode := range []os.FileMode{0, 0o600, 0o755} {
			for _, outcome := range []string{"success", "chmod-failure", "write-failure", "cancelled"} {
				t.Run(fmt.Sprintf("remote=%v/mode=%o/%s", remote, mode, outcome), func(t *testing.T) {
					manager, conn, client, fixture := newPermissionFixture(t)
					seedPermissionFile(t, client, "/target", "original", mode)
					seedPermissionFile(t, client, "/source", strings.Repeat("x", 300000), 0o755)
					local := filepath.Join(t.TempDir(), "source")
					if err := os.WriteFile(local, []byte(strings.Repeat("x", 300000)), 0o600); err != nil {
						t.Fatal(err)
					}
					ctx, cancel := context.WithCancel(context.Background())
					defer cancel()
					fixture.mu.Lock()
					fixture.rejectChmod = outcome == "chmod-failure"
					fixture.rejectWrite = outcome == "write-failure"
					if outcome == "cancelled" {
						fixture.cancelWrite = cancel
					}
					fixture.mu.Unlock()
					var err error
					if remote {
						err = manager.serverToServer(ctx, &Task{ID: "remote", RemotePath: "/source", PeerPath: "/target"}, conn, &sshclient.Conn{ID: "peer"})
					} else {
						err = manager.upload(ctx, &Task{ID: "upload", LocalPath: local, RemotePath: "/target"}, conn)
					}
					if (err == nil) != (outcome == "success") {
						t.Fatalf("outcome %s error=%v", outcome, err)
					}
					info, err := client.Stat("/target")
					if err != nil {
						t.Fatal(err)
					}
					if info.Mode().Perm() != mode {
						t.Fatalf("mode=%o want %o", info.Mode().Perm(), mode)
					}
					file, err := client.Open("/target")
					if err != nil {
						t.Fatal(err)
					}
					data, err := io.ReadAll(file)
					file.Close()
					if err != nil {
						t.Fatal(err)
					}
					if outcome != "success" && string(data) != "original" {
						t.Fatal("failed transfer changed destination")
					}
					fixture.mu.Lock()
					defer fixture.mu.Unlock()
					if len(fixture.modes) != 2 {
						t.Fatalf("temporary files retained: %v", fixture.modes)
					}
				})
			}
		}
	}
}

func TestNewRemoteCopyUsesSourceMode(t *testing.T) {
	manager, conn, client, _ := newPermissionFixture(t)
	seedPermissionFile(t, client, "/source", "script", 0o755)
	if err := manager.serverToServer(context.Background(), &Task{ID: "remote", RemotePath: "/source", PeerPath: "/target"}, conn, &sshclient.Conn{ID: "peer"}); err != nil {
		t.Fatal(err)
	}
	info, err := client.Stat("/target")
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o755 {
		t.Fatalf("new target mode=%o", info.Mode().Perm())
	}
}

func TestNewUploadUsesSafeWindowsMode(t *testing.T) {
	manager, conn, client, _ := newPermissionFixture(t)
	local := filepath.Join(t.TempDir(), "source")
	if err := os.WriteFile(local, []byte("private configuration"), 0o600); err != nil {
		t.Fatal(err)
	}
	source, err := os.Stat(local)
	if err != nil {
		t.Fatal(err)
	}
	if err := manager.upload(context.Background(), &Task{ID: "new", LocalPath: local, RemotePath: "/target"}, conn); err != nil {
		t.Fatal(err)
	}
	got, err := client.Stat("/target")
	if err != nil {
		t.Fatal(err)
	}
	want := source.Mode().Perm()
	if runtime.GOOS == "windows" {
		want = 0o600
	}
	if got.Mode().Perm() != want {
		t.Fatalf("new upload mode=%o, want %o (local mode=%o)", got.Mode().Perm(), want, source.Mode().Perm())
	}
}

func TestCleanupFailureSurvivesFailedAndCancelledStatus(t *testing.T) {
	for _, remote := range []bool{false, true} {
		for _, state := range []State{Failed, Cancelled, Interrupted} {
			t.Run(fmt.Sprintf("remote=%v/%s", remote, state), func(t *testing.T) {
				manager, conn, client, fixture := newPermissionFixture(t)
				seedPermissionFile(t, client, "/source", "source", 0o600)
				local := filepath.Join(t.TempDir(), "source")
				if err := os.WriteFile(local, []byte("source"), 0o600); err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithCancel(context.Background())
				defer cancel()
				task := &Task{ID: "cleanup", ConnectionID: conn.ID, LocalPath: local, RemotePath: "/target", Direction: Upload, state: Queued, cancel: cancel, interrupted: state == Interrupted}
				if remote {
					task.Direction, task.RemotePath, task.PeerPath, task.PeerConnectionID = ServerToServer, "/source", "/target", "peer"
				}
				if err := manager.addTask(task); err != nil {
					t.Fatal(err)
				}
				fixture.mu.Lock()
				fixture.rejectRemove = true
				fixture.rejectWrite = state == Failed
				if state != Failed {
					fixture.cancelWrite = cancel
				}
				fixture.mu.Unlock()
				if remote {
					manager.runRemote(ctx, task, conn, &sshclient.Conn{ID: "peer"})
				} else {
					manager.run(ctx, task, conn)
				}
				got := task.snapshot()
				if got.State != state {
					t.Fatalf("state=%s, want %s", got.State, state)
				}
				temp := "/target.uploading-cleanup"
				if remote {
					temp = "/target.copying-cleanup"
				}
				if !strings.Contains(got.Error, "cleanup") || !strings.Contains(got.Error, temp) {
					t.Fatalf("cleanup failure lost from status: %+v", got)
				}
				if _, err := client.Stat(temp); err != nil {
					t.Fatalf("fixture should retain rejected temporary file: %v", err)
				}
			})
		}
	}
}
