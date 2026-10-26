package transfer

import (
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestStartChecksActualDirectionPaths(t *testing.T) {
	for _, dir := range []Direction{Download, Upload} {
		for _, rejectedSuffix := range []string{"", ".part", ".part.meta"} {
			t.Run(string(dir)+"/"+rejectedSuffix, func(t *testing.T) {
				manager, conn, client := newAdmissionFixture(t)
				localPath := filepath.Join(t.TempDir(), "target")
				if dir == Upload {
					if err := os.WriteFile(localPath, []byte("upload"), 0o600); err != nil {
						t.Fatal(err)
					}
				}
				file, err := client.Create("/remote")
				if err != nil {
					t.Fatal(err)
				}
				if _, err := file.Write([]byte("download")); err != nil {
					t.Fatal(err)
				}
				if err := file.Close(); err != nil {
					t.Fatal(err)
				}
				checked := make([]string, 0, 3)
				allow := func(path string) bool { checked = append(checked, path); return path != localPath+rejectedSuffix }
				task, err := manager.Start(conn, dir, "/remote", localPath, allow)
				wantReject := dir == Download || rejectedSuffix == ""
				if wantReject {
					if err == nil {
						waitAdmissionTask(t, task)
						t.Fatal("forbidden actual I/O path started")
					}
					if len(manager.List()) != 0 {
						t.Fatal("rejection registered a task")
					}
				} else {
					if err != nil {
						t.Fatal(err)
					}
					if status := waitAdmissionTask(t, task); status.State != Done {
						t.Fatalf("upload failed: %s %s", status.State, status.Error)
					}
					if len(checked) != 1 || checked[0] != localPath {
						t.Errorf("upload checked unused sidecars: %v", checked)
					}
				}
			})
		}
	}
}

func TestRetryAllowedCompletesLocalTransfer(t *testing.T) {
	manager, conn, client := newAdmissionFixture(t)
	localPath := filepath.Join(t.TempDir(), "target")
	allow := func(string) bool { return true }
	old, err := manager.Start(conn, Download, "/remote", localPath, allow)
	if err != nil {
		t.Fatal(err)
	}
	if status := waitAdmissionTask(t, old); status.State != Failed {
		t.Fatalf("want failed fixture task: %s", status.State)
	}
	remote, err := client.Create("/remote")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := remote.Write([]byte("replacement")); err != nil {
		t.Fatal(err)
	}
	if err := remote.Close(); err != nil {
		t.Fatal(err)
	}
	id, err := manager.Retry(old.ID, conn, allow)
	if err != nil {
		t.Fatal(err)
	}
	manager.mu.Lock()
	task := manager.tasks[id]
	manager.mu.Unlock()
	if status := waitAdmissionTask(t, task); status.State != Done {
		t.Fatalf("retry failed: %s %s", status.State, status.Error)
	}
	data, err := os.ReadFile(localPath)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "replacement" {
		t.Errorf("retry content=%q", data)
	}
	for _, suffix := range []string{".part", ".part.meta"} {
		if _, err := os.Stat(localPath + suffix); !os.IsNotExist(err) {
			t.Errorf("sidecar retained: %s %v", suffix, err)
		}
	}
	file, err := client.Open("/remote")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := io.ReadAll(file); err != nil {
		t.Fatal(err)
	}
	file.Close()
}

func TestStartRequiresAdmission(t *testing.T) {
	manager, conn, _ := newAdmissionFixture(t)
	if _, err := manager.Start(conn, Download, "/remote", filepath.Join(t.TempDir(), "target"), nil); err == nil {
		t.Fatal("missing admission must fail closed")
	}
	if len(manager.List()) != 0 {
		t.Fatal("missing admission registered a task")
	}
}
