package server

import (
	"context"
	"encoding/json"
	"testing"
)

func TestTerminalReadMultiRejectsEmptySessionKeys(t *testing.T) {
	app := newTestApp(t)
	if _, err := invoke(t, app.Handlers()["terminal.readMulti"], `{"sessionKeys":[]}`); err == nil {
		t.Fatal("empty sessionKeys must be rejected")
	}
}

// 会话不存在时报 eof（与 terminal.read 的收尾语义一致），让 UI 停止轮询它。
func TestTerminalReadMultiReportsEofForUnknownSession(t *testing.T) {
	app := newTestApp(t)
	res, err := invoke(t, app.Handlers()["terminal.readMulti"],
		`{"sessionKeys":["t_missing"],"maxBytes":1024,"waitMillis":1000}`)
	if err != nil {
		t.Fatalf("read multi: %v", err)
	}
	events, ok := res["events"].([]map[string]any)
	if !ok {
		t.Fatalf("unexpected events type %T", res["events"])
	}
	if len(events) != 1 {
		t.Fatalf("events=%d want 1", len(events))
	}
	event := events[0]
	if event["sessionKey"] != "t_missing" || event["eof"] != true {
		t.Fatalf("event=%+v", event)
	}
	if data, _ := event["dataBase64"].(string); data != "" {
		t.Fatalf("missing session must not carry data: %q", data)
	}
}

// 批量读是读命令：只读模式下也必须可用，否则只读开关会让终端画面静止。
func TestTerminalReadMultiStaysAvailableInReadOnlyMode(t *testing.T) {
	app := newTestApp(t)
	handlers := app.Handlers()
	if _, err := handlers["settings.set"](context.Background(), json.RawMessage(
		`{"settings":{"readOnly":true,"historyLimit":100,"sudoAllowlist":["cat"],"quickCommands":[]}}`)); err != nil {
		t.Fatalf("enable readonly: %v", err)
	}
	if _, err := invoke(t, handlers["terminal.readMulti"], `{"sessionKeys":["t_missing"],"waitMillis":0}`); err != nil {
		t.Fatalf("read command under readonly: %v", err)
	}
}
