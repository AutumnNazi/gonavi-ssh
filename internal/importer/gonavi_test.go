package importer

import (
	"os"
	"path/filepath"
	"testing"

	"gonavi-ssh/internal/profile"
)

func writeGonaviRoot(t *testing.T, connectionsJSON string) string {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "connections.json"), []byte(connectionsJSON), 0o600); err != nil {
		t.Fatalf("write connections.json: %v", err)
	}
	t.Setenv("GONAVI_SSH_GONAVI_ROOT", root)
	return root
}

// 带 SSH 隧道的连接被导入为档案；非 SSH 连接与已导入的跳过（幂等）。
func TestImportFromGonavi(t *testing.T) {
	writeGonaviRoot(t, `{
      "connections": [
        {"id":"1","name":"生产库","config":{"useSSH":true,"ssh":{"host":"10.0.0.5","port":2222,"user":"admin","keyPath":"/home/me/.ssh/id_ed25519"}}},
        {"id":"2","name":"本地库","config":{"useSSH":false,"ssh":{"host":"","port":0,"user":""}}},
        {"id":"3","name":"缓存库","config":{"useSSH":true,"ssh":{"host":"10.0.0.6","user":""}}}
      ]
    }`)
	store, err := profile.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	res, err := ImportFromGonavi(store, "")
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	if res.Imported != 2 || res.Skipped != 1 {
		t.Fatalf("imported=%d skipped=%d", res.Imported, res.Skipped)
	}
	list := store.List()
	if len(list) != 2 {
		t.Fatalf("store has %d profiles", len(list))
	}
	byName := map[string]profile.Profile{}
	for _, p := range list {
		byName[p.Name] = p
	}
	prod := byName["生产库"]
	if prod.Host != "10.0.0.5" || prod.Port != 2222 || prod.User != "admin" || prod.AuthMethod != profile.AuthKey {
		t.Fatalf("prod profile wrong: %+v", prod)
	}
	cache := byName["缓存库"]
	if cache.User != "root" || cache.AuthMethod != profile.AuthPassword {
		t.Fatalf("cache profile wrong: %+v", cache)
	}

	// 幂等：再导入一次全部跳过。
	res2, err := ImportFromGonavi(store, "")
	if err != nil {
		t.Fatalf("reimport: %v", err)
	}
	if res2.Imported != 0 || res2.Skipped != 3 {
		t.Fatalf("reimport imported=%d skipped=%d", res2.Imported, res2.Skipped)
	}
}

// 宿主目录不存在时静默返回空结果。
func TestImportMissingRoot(t *testing.T) {
	t.Setenv("GONAVI_SSH_GONAVI_ROOT", filepath.Join(t.TempDir(), "nope"))
	store, _ := profile.Open(t.TempDir())
	res, err := ImportFromGonavi(store, "")
	if err != nil {
		t.Fatalf("missing root must not error: %v", err)
	}
	if res.Imported != 0 {
		t.Fatalf("imported=%d", res.Imported)
	}
}

// 宿主格式变化（JSON 结构不同）时报可读错误而不是崩。
func TestImportMalformedTolerated(t *testing.T) {
	writeGonaviRoot(t, `{"connections": "not-an-array"}`)
	store, _ := profile.Open(t.TempDir())
	if _, err := ImportFromGonavi(store, ""); err == nil {
		t.Fatal("malformed file must surface an error")
	}
}
