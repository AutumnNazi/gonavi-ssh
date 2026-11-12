package sftpops

import (
	"fmt"
	"io"
	"net"
	"os"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pkg/sftp"
	"gonavi-ssh/internal/sshclient"
)

type refreshedDirectory struct {
	sftp.FileLister
	count      atomic.Int64
	calls      atomic.Int64
	invalidate atomic.Bool
	manager    *Manager
}

func (l *refreshedDirectory) Filelist(r *sftp.Request) (sftp.ListerAt, error) {
	if r.Method != "List" {
		return l.FileLister.Filelist(r)
	}
	l.calls.Add(1)
	result := generatedDirectory(l.count.Load())
	if l.invalidate.CompareAndSwap(true, false) {
		// Another connection may finish a mutation while this read is in flight.
		l.manager.Invalidate("other-connection")
	}
	return result, nil
}

type generatedDirectory int64

func (d generatedDirectory) ListAt(dst []os.FileInfo, off int64) (int, error) {
	n := 0
	for n < len(dst) && off+int64(n) < int64(d) {
		dst[n] = generatedDirectoryEntry(off + int64(n))
		n++
	}
	if off+int64(n) >= int64(d) {
		return n, io.EOF
	}
	return n, nil
}

type generatedDirectoryEntry int64

func (e generatedDirectoryEntry) Name() string       { return fmt.Sprintf("entry%06d", e) }
func (e generatedDirectoryEntry) Size() int64        { return 1 }
func (e generatedDirectoryEntry) Mode() os.FileMode  { return 0o644 }
func (e generatedDirectoryEntry) ModTime() time.Time { return time.Unix(0, 0) }
func (e generatedDirectoryEntry) IsDir() bool        { return false }
func (e generatedDirectoryEntry) Sys() any           { return nil }

func TestUncachedRefreshCannotReusePreviousSnapshot(t *testing.T) {
	for _, tc := range []struct {
		name       string
		count      int64
		invalidate bool
	}{
		{name: "oversized directory", count: maxCachedEntries + 1},
		{name: "another connection invalidates while reading", count: 3, invalidate: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m := NewManager()
			handlers := sftp.InMemHandler()
			lister := &refreshedDirectory{FileLister: handlers.FileList, manager: m}
			lister.count.Store(2)
			handlers.FileList = lister
			a, b := net.Pipe()
			server := sftp.NewRequestServer(a, handlers)
			done := make(chan error, 1)
			go func() { done <- server.Serve() }()
			client, err := sftp.NewClientPipe(b, b)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { client.Close(); server.Close(); <-done })
			conn := &sshclient.Conn{ID: "refresh"}
			m.clients[conn.ID] = client
			if _, _, err := m.List(conn, "/", 0, 1, "name"); err != nil {
				t.Fatal(err)
			}
			lister.count.Store(tc.count)
			lister.invalidate.Store(tc.invalidate)
			if entries, more, err := m.List(conn, "/", 0, 1, "name"); err != nil || len(entries) != 1 || !more {
				t.Fatalf("refresh failed: entries=%v more=%v err=%v", entries, more, err)
			}
			entries, more, err := m.List(conn, "/", 2, 1, "name")
			if err != nil || len(entries) != 1 || entries[0].Name != "entry000002" || more != (tc.count > 3) {
				t.Fatalf("page reused the pre-refresh snapshot: entries=%v more=%v err=%v", entries, more, err)
			}
			if got := lister.calls.Load(); got != 3 {
				t.Fatalf("uncached next page must read the directory again, reads=%d", got)
			}
			m.mu.Lock()
			reads := len(m.listingReads)
			m.mu.Unlock()
			if reads != 0 {
				t.Fatalf("completed directory reads retained %d generation keys", reads)
			}
		})
	}
}

type listingCounter struct {
	sftp.FileLister
	calls atomic.Int64
}

type overlappingLister struct {
	sftp.FileLister
	first    atomic.Bool
	captured chan struct{}
	release  chan struct{}
}

func (l *overlappingLister) Filelist(r *sftp.Request) (sftp.ListerAt, error) {
	result, err := l.FileLister.Filelist(r)
	if r.Method == "List" && l.first.CompareAndSwap(false, true) {
		close(l.captured)
		<-l.release
	}
	return result, err
}

func TestOverlappingRefreshCannotRestoreOlderDirectoryPage(t *testing.T) {
	handlers := sftp.InMemHandler()
	lister := &overlappingLister{FileLister: handlers.FileList, captured: make(chan struct{}), release: make(chan struct{})}
	handlers.FileList = lister
	a, b := net.Pipe()
	server := sftp.NewRequestServer(a, handlers)
	done := make(chan error, 1)
	go func() { done <- server.Serve() }()
	client, err := sftp.NewClientPipe(b, b)
	if err != nil {
		t.Fatal(err)
	}
	var release sync.Once
	t.Cleanup(func() { release.Do(func() { close(lister.release) }); client.Close(); server.Close(); <-done })
	m := NewManager()
	conn := &sshclient.Conn{ID: "overlap"}
	m.clients[conn.ID] = client
	for _, name := range []string{"/a", "/b"} {
		f, err := client.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		f.Close()
	}
	oldDone := make(chan error, 1)
	go func() { _, _, err := m.List(conn, "/", 0, 1, "name"); oldDone <- err }()
	select {
	case <-lister.captured:
	case <-time.After(3 * time.Second):
		t.Fatal("first refresh did not start")
	}
	// RequestServer orders replies within a channel. A second channel models
	// a remote server completing a later directory read before the first one.
	a2, b2 := net.Pipe()
	server2 := sftp.NewRequestServer(a2, handlers)
	done2 := make(chan error, 1)
	go func() { done2 <- server2.Serve() }()
	client2, err := sftp.NewClientPipe(b2, b2)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client2.Close(); server2.Close(); <-done2 })
	m.mu.Lock()
	m.clients[conn.ID] = client2
	m.mu.Unlock()
	f, err := client2.Create("/c")
	if err != nil {
		t.Fatal(err)
	}
	f.Close()
	if _, _, err := m.List(conn, "/", 0, 1, "name"); err != nil {
		t.Fatal(err)
	}
	release.Do(func() { close(lister.release) })
	if err := <-oldDone; err != nil {
		t.Fatal(err)
	}
	entries, _, err := m.List(conn, "/", 2, 1, "name")
	if err != nil || len(entries) != 1 || entries[0].Name != "c" {
		t.Fatalf("new directory cache replaced by stale refresh: entries=%v err=%v", entries, err)
	}
}

func (c *listingCounter) Filelist(r *sftp.Request) (sftp.ListerAt, error) {
	if r.Method == "List" {
		c.calls.Add(1)
	}
	return c.FileLister.Filelist(r)
}

func TestDirectoryPagesReuseSnapshotAndRefreshAfterMutation(t *testing.T) {
	handlers := sftp.InMemHandler()
	counter := &listingCounter{FileLister: handlers.FileList}
	handlers.FileList = counter
	serverPipe, clientPipe := net.Pipe()
	server := sftp.NewRequestServer(serverPipe, handlers)
	done := make(chan error, 1)
	go func() { done <- server.Serve() }()
	client, err := sftp.NewClientPipe(clientPipe, clientPipe)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { client.Close(); server.Close(); <-done })
	m := NewManager()
	conn := &sshclient.Conn{ID: "listing"}
	m.clients[conn.ID] = client
	for i := 0; i < 5; i++ {
		f, err := client.Create(fmt.Sprintf("/%d", i))
		if err != nil {
			t.Fatal(err)
		}
		f.Close()
	}
	for page := 0; page < 3; page++ {
		entries, more, err := m.List(conn, "/", page*2, 2, "name")
		if err != nil {
			t.Fatal(err)
		}
		if len(entries) == 0 || entries[0].Name != fmt.Sprint(page*2) || more != (page < 2) {
			t.Fatalf("page=%d entries=%v more=%v", page, entries, more)
		}
		entries[0].Name = "caller cannot corrupt cached entries"
	}
	if got := counter.calls.Load(); got != 1 {
		t.Fatalf("three pages read directory %d times", got)
	}
	entries, _, err := m.List(conn, "/", 2, 2, "name")
	if err != nil {
		t.Fatal(err)
	}
	if entries[0].Name != "2" {
		t.Fatal("cached entry mutated by caller")
	}
	if _, _, err := m.List(conn, "/", 0, 2, "name"); err != nil {
		t.Fatal(err)
	}
	if got := counter.calls.Load(); got != 2 {
		t.Fatalf("refresh did not read directory: %d", got)
	}
	if err := m.WriteFile(conn, "/new", []byte("new")); err != nil {
		t.Fatal(err)
	}
	entries, more, err := m.List(conn, "/", 4, 2, "name")
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 2 || entries[1].Name != "new" || more {
		t.Fatalf("mutation not visible: %v", entries)
	}
	if got := counter.calls.Load(); got != 3 {
		t.Fatalf("mutation failed to invalidate snapshot: %d", got)
	}
	m.mu.Lock()
	for key, snapshot := range m.listings {
		snapshot.created = time.Now().Add(-directoryCacheTTL)
		m.listings[key] = snapshot
	}
	m.mu.Unlock()
	if _, _, err := m.List(conn, "/", 2, 2, "name"); err != nil {
		t.Fatal(err)
	}
	if got := counter.calls.Load(); got != 4 {
		t.Fatalf("expired snapshot not reloaded: %d", got)
	}
}

func TestDirectoryCacheBoundedAndDoesNotResurrectInvalidatedReads(t *testing.T) {
	m := NewManager()
	for i := 0; i < maxCachedDirectories+3; i++ {
		m.cacheDirectory(directoryKey{connectionID: "c", path: fmt.Sprint(i)}, []Entry{{Name: "entry"}}, 0, 0)
	}
	if len(m.listings) != maxCachedDirectories {
		t.Fatalf("directory cache grew to %d", len(m.listings))
	}
	m.Invalidate("c")
	key := directoryKey{connectionID: "c", path: "/"}
	m.cacheDirectory(key, []Entry{{Name: "stale"}}, 0, 0)
	if len(m.listings) != 0 {
		t.Fatal("in-flight stale read restored invalidated listing")
	}
	m.cacheDirectory(key, make([]Entry, maxCachedEntries+1), m.listingEpoch, 0)
	if len(m.listings) != 0 {
		t.Fatal("oversized listing retained")
	}
}
