package server

import (
	"context"
	"encoding/json"
	"os"
	"testing"
	"time"

	goplugin "github.com/Syngnat/GoNavi/sdk/go"

	"gonavi-ssh/internal/profile"
)

// profileSanitizedView 是断言用的类型别名，避免魔法类型断言。
type profileSanitizedView = profile.Sanitized

func newTestApp(t *testing.T) *App {
	t.Helper()
	app, err := New(t.TempDir())
	if err != nil {
		t.Fatalf("new app: %v", err)
	}
	t.Cleanup(app.Shutdown)
	return app
}

func invoke(t *testing.T, h goplugin.Handler, args string) (map[string]any, error) {
	t.Helper()
	res, err := h(context.Background(), json.RawMessage(args))
	if err != nil {
		return nil, err
	}
	m, ok := res.(map[string]any)
	if !ok {
		t.Fatalf("unexpected result type %T", res)
	}
	return m, nil
}

func TestProfileSaveAndList(t *testing.T) {
	app := newTestApp(t)
	res, err := invoke(t, app.Handlers()["profile.save"],
		`{"profile":{"name":"prod","host":"10.0.0.1","port":2222,"user":"root","authMethod":"password","password":"pw"}}`)
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	prof, ok := res["profile"].(profileSanitizedView)
	if !ok {
		t.Fatalf("unexpected profile type %T", res["profile"])
	}
	id := prof.ID
	if prof.Port != 2222 {
		t.Fatalf("port not persisted: %v", prof.Port)
	}

	list, err := invoke(t, app.Handlers()["profile.list"], `{}`)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	profiles := list["profiles"].([]profileSanitizedView)
	if len(profiles) != 1 {
		t.Fatalf("want 1 profile, got %d", len(profiles))
	}

	// 删除后列表为空。
	if _, err := invoke(t, app.Handlers()["profile.delete"], `{"id":"`+id+`"}`); err != nil {
		t.Fatalf("delete: %v", err)
	}
	list2, _ := invoke(t, app.Handlers()["profile.list"], `{}`)
	if n := len(list2["profiles"].([]profileSanitizedView)); n != 0 {
		t.Fatalf("want 0 profiles after delete, got %d", n)
	}
}

func TestProfileListKeepsCreationOrderAfterRefreshAndEdit(t *testing.T) {
	app := newTestApp(t)
	base := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	for _, p := range []profile.Profile{
		{ID: "last", CreatedAt: base.Add(time.Hour)},
		{ID: "same-b", CreatedAt: base},
		{ID: "first", CreatedAt: base.Add(-time.Hour)},
		{ID: "same-a", CreatedAt: base},
	} {
		p.Name, p.Host, p.User, p.AuthMethod = p.ID, "fixture", "ops", profile.AuthNone
		if _, err := app.profiles.Upsert(p); err != nil {
			t.Fatal(err)
		}
	}
	want := []string{"first", "same-a", "same-b", "last"}
	check := func() {
		t.Helper()
		for attempt := 0; attempt < 24; attempt++ {
			res, err := invoke(t, app.Handlers()["profile.list"], `{}`)
			if err != nil {
				t.Fatal(err)
			}
			got := res["profiles"].([]profileSanitizedView)
			if len(got) != len(want) {
				t.Fatal("profile count changed")
			}
			for i, id := range want {
				if got[i].ID != id {
					t.Fatalf("profile.list order %d: got %s want %s", i, got[i].ID, id)
				}
			}
		}
	}
	check()
	if _, err := invoke(t, app.Handlers()["profile.save"], `{"profile":{"id":"same-b","name":"alphabetically-first","host":"fixture","user":"ops","authMethod":"none"}}`); err != nil {
		t.Fatal(err)
	}
	check()
}

func TestProfileSaveValidation(t *testing.T) {
	app := newTestApp(t)
	_, err := invoke(t, app.Handlers()["profile.save"],
		`{"profile":{"name":"x","host":"h","user":"u","authMethod":"bogus"}}`)
	if err == nil {
		t.Fatal("invalid authMethod must fail")
	}
	perr, ok := err.(*goplugin.Error)
	if !ok || perr.Code != errBadArgument {
		t.Fatalf("want bad-argument error, got %#v", err)
	}
}

// 空参数与非法 JSON 统一报参数错误。
func TestDecodeRejectsEmptyAndGarbage(t *testing.T) {
	app := newTestApp(t)
	if _, err := invoke(t, app.Handlers()["conn.open"], ``); err == nil {
		t.Fatal("empty args must fail")
	}
	if _, err := invoke(t, app.Handlers()["conn.open"], `{nope`); err == nil {
		t.Fatal("garbage args must fail")
	}
}

func TestEmptyConnectionStatusSerializesAsArray(t *testing.T) {
	app := newTestApp(t)
	for _, args := range []string{`{}`, `{"connectionId":"missing"}`} {
		res, err := invoke(t, app.Handlers()["conn.status"], args)
		if err != nil {
			t.Fatal(err)
		}
		encoded, err := json.Marshal(res)
		if err != nil {
			t.Fatal(err)
		}
		var wire map[string]json.RawMessage
		if err := json.Unmarshal(encoded, &wire); err != nil {
			t.Fatal(err)
		}
		if string(wire["connections"]) != "[]" {
			t.Fatalf("empty connection list must be [], got %s", encoded)
		}
	}
}

func TestConnOpenUnknownProfile(t *testing.T) {
	app := newTestApp(t)
	_, err := invoke(t, app.Handlers()["conn.open"], `{"profileId":"missing"}`)
	perr, ok := err.(*goplugin.Error)
	if !ok || perr.Code != errNotFound {
		t.Fatalf("want not-found, got %#v", err)
	}
}

func TestTerminalUnknownConnection(t *testing.T) {
	app := newTestApp(t)
	_, err := invoke(t, app.Handlers()["terminal.open"], `{"connectionId":"c_missing","cols":80,"rows":24}`)
	perr, ok := err.(*goplugin.Error)
	if !ok || perr.Code != errNotFound {
		t.Fatalf("want not-found, got %#v", err)
	}
}

// terminal.read 对未知会话返回 eof（会话可能刚结束被摘除），而不是错误，
// 让 UI 能自然停止轮询。
func TestTerminalReadUnknownSessionReturnsEof(t *testing.T) {
	app := newTestApp(t)
	res, err := invoke(t, app.Handlers()["terminal.read"], `{"sessionKey":"t_gone"}`)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if res["eof"] != true {
		t.Fatalf("want eof=true, got %v", res["eof"])
	}
}

func TestTerminalWriteBadBase64(t *testing.T) {
	app := newTestApp(t)
	// 会话不存在时先报 not-found；base64 非法属于参数错误路径，
	// 真实会话的 base64 校验由 Session.Write 前的解码保证。
	_, err := invoke(t, app.Handlers()["terminal.write"], `{"sessionKey":"t_gone","dataBase64":"!!!"}`)
	perr, ok := err.(*goplugin.Error)
	if !ok || perr.Code != errNotFound {
		t.Fatalf("unexpected error: %#v", err)
	}
}

// 清单里的命令与 handlers 注册表必须一一对应（契约测试）。
func TestManifestCoversAllHandlers(t *testing.T) {
	data, err := os.ReadFile("../../gonavi.plugin.json")
	if err != nil {
		t.Fatalf("read manifest: %v", err)
	}
	var manifest struct {
		Contributes struct {
			Commands []struct {
				ID string `json:"id"`
			} `json:"commands"`
		} `json:"contributes"`
	}
	if err := json.Unmarshal(data, &manifest); err != nil {
		t.Fatalf("parse manifest: %v", err)
	}
	declared := map[string]bool{}
	for _, c := range manifest.Contributes.Commands {
		declared[c.ID] = true
	}
	handlers := newTestApp(t).Handlers()
	for id := range handlers {
		if !declared[id] {
			t.Errorf("handler %q is not declared in gonavi.plugin.json", id)
		}
	}
	for id := range declared {
		if _, ok := handlers[id]; !ok {
			t.Errorf("manifest command %q has no handler", id)
		}
	}
}
