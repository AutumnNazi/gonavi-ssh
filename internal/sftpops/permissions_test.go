package sftpops

import (
	"io"
	"net"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/pkg/sftp"

	"gonavi-ssh/internal/sshclient"
)

type permissionFixture struct {
	sftp.Handlers
	mu          sync.Mutex
	modes       map[string]os.FileMode
	rejectChmod bool
	rejectStat  bool
	writes      int
	renames     int
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
	w.fixture.mu.Unlock()
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
	manager := NewManager()
	manager.clients[conn.ID] = client
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

func TestPermissionsFailureDoesNotPublish(t *testing.T) {
	for _, mode := range []os.FileMode{0o600, 0o755} {
		for _, operation := range []string{"write", "copy"} {
			t.Run(operation+"/"+mode.String(), func(t *testing.T) {
				manager, conn, client, fixture := newPermissionFixture(t)
				seedPermissionFile(t, client, "/target", "original", mode)
				seedPermissionFile(t, client, "/source", "replacement", 0o755)
				fixture.mu.Lock()
				fixture.rejectChmod = true
				fixture.writes = 0
				fixture.renames = 0
				fixture.mu.Unlock()
				var err error
				if operation == "write" {
					err = manager.WriteFile(conn, "/target", []byte("replacement"))
				} else {
					err = manager.Copy(conn, "/source", "/target")
				}
				if err == nil {
					t.Error("permission refusal must fail the operation")
				}
				file, openErr := client.Open("/target")
				if openErr != nil {
					t.Fatal(openErr)
				}
				data, readErr := io.ReadAll(file)
				file.Close()
				if readErr != nil {
					t.Fatal(readErr)
				}
				if string(data) != "original" {
					t.Errorf("target overwritten: %q", data)
				}
				info, statErr := client.Stat("/target")
				if statErr != nil {
					t.Fatal(statErr)
				}
				if info.Mode().Perm() != mode {
					t.Errorf("target mode changed: %o", info.Mode().Perm())
				}
				fixture.mu.Lock()
				defer fixture.mu.Unlock()
				if fixture.writes != 0 || fixture.renames != 0 {
					t.Errorf("failure wrote body or renamed: writes=%d renames=%d", fixture.writes, fixture.renames)
				}
				for path := range fixture.modes {
					if strings.Contains(path, ".saving-") || strings.Contains(path, ".copying-") {
						t.Errorf("temporary file retained: %s", path)
					}
				}
			})
		}
	}
}
