package server

import (
	"context"
	"encoding/json"
	"testing"

	goplugin "github.com/Syngnat/GoNavi/sdk/go"

	"gonavi-ssh/internal/settings"
)

// 只读模式：写命令被拒、读命令可用；开关本身是写命令但允许在只读下
// 保持/开启只读（settings.set 更新被 settings.Store 的强制逻辑约束）。
func TestReadOnlyGate(t *testing.T) {
	app := newTestApp(t)
	handlers := app.Handlers()

	// 保存一个档案（只读未开）。
	if _, err := handlers["profile.save"](context.Background(), json.RawMessage(
		`{"profile":{"name":"ro","host":"h","user":"u","authMethod":"agent"}}`)); err != nil {
		t.Fatalf("save before readonly: %v", err)
	}

	// 打开只读。
	if _, err := handlers["settings.set"](context.Background(), json.RawMessage(
		`{"settings":{"readOnly":true,"historyLimit":100,"sudoAllowlist":["cat"],"quickCommands":[]}}`)); err != nil {
		t.Fatalf("enable readonly: %v", err)
	}

	// 写命令被拒。
	_, err := handlers["profile.delete"](context.Background(), json.RawMessage(`{"id":"x"}`))
	perr, ok := err.(*goplugin.Error)
	if !ok || perr.Code != errReadOnly {
		t.Fatalf("want read-only rejection, got %#v", err)
	}

	// 读命令仍可用。
	if _, err := handlers["profile.list"](context.Background(), json.RawMessage(`{}`)); err != nil {
		t.Fatalf("read command under readonly: %v", err)
	}

	// 关闭只读恢复写。
	if _, err := handlers["settings.set"](context.Background(), json.RawMessage(
		`{"settings":{"readOnly":false,"historyLimit":100,"sudoAllowlist":["cat"],"quickCommands":[]}}`)); err != nil {
		t.Fatalf("disable readonly: %v", err)
	}
	if _, err := handlers["profile.save"](context.Background(), json.RawMessage(
		`{"profile":{"name":"rw","host":"h","user":"u","authMethod":"agent"}}`)); err != nil {
		t.Fatalf("save after readonly off: %v", err)
	}
}

// settings 默认值加载与往返。
func TestSettingsGetDefault(t *testing.T) {
	app := newTestApp(t)
	res, err := app.Handlers()["settings.get"](context.Background(), json.RawMessage(`{}`))
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	m := res.(map[string]any)
	st := m["settings"].(settings.Settings)
	if st.HistoryLimit <= 0 || len(st.SudoAllowlist) == 0 {
		t.Fatalf("bad defaults: %+v", st)
	}
}
