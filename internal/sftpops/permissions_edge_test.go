package sftpops

import (
	"io"
	"os"
	"testing"
)

func TestPermissionsSuccessPreservesMode(t *testing.T) {
	for _, mode := range []os.FileMode{0, 0o600, 0o755} {
		for _, operation := range []string{"write", "copy"} {
			t.Run(operation+"/"+mode.String(), func(t *testing.T) {
				manager, conn, client, fixture := newPermissionFixture(t)
				seedPermissionFile(t, client, "/target", "original", mode)
				seedPermissionFile(t, client, "/source", "replacement", mode)
				var err error
				if operation == "write" {
					err = manager.WriteFile(conn, "/target", []byte("replacement"))
				} else {
					err = manager.Copy(conn, "/source", "/target")
				}
				if err != nil {
					t.Fatal(err)
				}
				info, err := client.Stat("/target")
				if err != nil {
					t.Fatal(err)
				}
				if info.Mode().Perm() != mode {
					t.Errorf("mode=%o want=%o", info.Mode().Perm(), mode)
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
				if string(data) != "replacement" {
					t.Errorf("content=%q", data)
				}
				fixture.mu.Lock()
				defer fixture.mu.Unlock()
				if len(fixture.modes) != 2 {
					t.Errorf("temporary file retained: %+v", fixture.modes)
				}
			})
		}
	}
}

func TestPermissionsStatFailureDoesNotCreateTemp(t *testing.T) {
	manager, conn, client, fixture := newPermissionFixture(t)
	seedPermissionFile(t, client, "/target", "original", 0o600)
	fixture.mu.Lock()
	fixture.rejectStat = true
	fixture.writes = 0
	fixture.renames = 0
	fixture.mu.Unlock()
	if err := manager.WriteFile(conn, "/target", []byte("replacement")); err == nil {
		t.Fatal("stat permission failure must fail")
	}
	fixture.mu.Lock()
	defer fixture.mu.Unlock()
	if fixture.writes != 0 || fixture.renames != 0 || len(fixture.modes) != 1 {
		t.Errorf("stat failure touched files: writes=%d renames=%d modes=%+v", fixture.writes, fixture.renames, fixture.modes)
	}
}

func TestPermissionsNewTarget(t *testing.T) {
	manager, conn, client, _ := newPermissionFixture(t)
	if err := manager.WriteFile(conn, "/target", []byte("new")); err != nil {
		t.Fatal(err)
	}
	info, err := client.Stat("/target")
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() != 3 {
		t.Errorf("size=%d", info.Size())
	}
}
