package server

import (
	"context"
	"encoding/json"
	"testing"

	goplugin "github.com/Syngnat/GoNavi/sdk/go"

	"gonavi-ssh/internal/settings"
)

// 只读模式只作用于 AI Agent 通道：人工能干的事（连接、终端输入、文件增删改、
// 档案管理）一件都不能少，否则开着只读插件就成了砖头。
func TestReadOnlyRestrictsOnlyAgentChannel(t *testing.T) {
	app := newTestApp(t)
	handlers := app.Handlers()

	// 打开只读。
	if _, err := handlers["settings.set"](context.Background(), json.RawMessage(
		`{"settings":{"readOnly":true,"historyLimit":100,"sudoAllowlist":["cat"],"quickCommands":[]}}`)); err != nil {
		t.Fatalf("enable readonly: %v", err)
	}

	// 人工通道一律放行：只断言"没有吃到只读拒绝"，具体业务错误（缺档案、
	// 连不上之类）不算问题。
	human := [][2]string{
		{"profile.save", `{"profile":{"name":"ro","host":"h","user":"u","authMethod":"agent"}}`},
		{"profile.delete", `{"id":"x"}`},
		{"profile.importFromGonavi", `{}`},
		{"conn.open", `{"profileId":"missing"}`},
		{"conn.answer", `{"connectionId":"missing","answers":["x"]}`},
		{"terminal.open", `{"connectionId":"missing"}`},
		{"terminal.write", `{"sessionKey":"missing","dataBase64":"bHM="}`},
		{"terminal.resize", `{"sessionKey":"missing","cols":80,"rows":24}`},
		{"sftp.mkdir", `{"connectionId":"missing","path":"/x"}`},
		{"sftp.remove", `{"connectionId":"missing","path":"/x"}`},
		{"sftp.writeFile", `{"connectionId":"missing","path":"/x","dataBase64":"aGk="}`},
		{"knownHosts.remove", `{"addr":"h"}`},
		{"transfer.start", `{"connectionId":"missing","direction":"download"}`},
	}
	for _, c := range human {
		_, err := handlers[c[0]](context.Background(), json.RawMessage(c[1]))
		if perr, ok := err.(*goplugin.Error); ok && perr.Code == errReadOnly {
			t.Fatalf("%s must stay usable in read-only mode: it is a human operation", c[0])
		}
	}

	// Agent 的后台执行仍然被拦：它没法事前核对命令。
	_, err := handlers["agent.runBg"](context.Background(), json.RawMessage(
		`{"connectionId":"missing","command":"uptime"}`))
	perr, ok := err.(*goplugin.Error)
	if !ok || perr.Code != errReadOnly {
		t.Fatalf("agent.runBg must stay rejected in read-only mode, got %#v", err)
	}

	// 关掉只读后 Agent 通道恢复。
	if _, err := handlers["settings.set"](context.Background(), json.RawMessage(
		`{"settings":{"readOnly":false,"historyLimit":100,"sudoAllowlist":["cat"],"quickCommands":[]}}`)); err != nil {
		t.Fatalf("disable readonly: %v", err)
	}
	if _, err := handlers["agent.runBg"](context.Background(), json.RawMessage(
		`{"connectionId":"missing","command":"uptime"}`)); err != nil {
		if perr, ok := err.(*goplugin.Error); ok && perr.Code == errReadOnly {
			t.Fatalf("agent.runBg must work once read-only is off, got %#v", err)
		}
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

// 只读模式下 session.teardown（窗口关闭清理）必须放行，否则连接残留。
func TestTeardownAllowedInReadOnly(t *testing.T) {
	app := newTestApp(t)
	handlers := app.Handlers()
	if _, err := handlers["settings.set"](context.Background(), json.RawMessage(
		`{"settings":{"readOnly":true,"historyLimit":100,"sudoAllowlist":[],"quickCommands":[]}}`)); err != nil {
		t.Fatalf("enable readonly: %v", err)
	}
	if _, err := handlers["session.teardown"](context.Background(), json.RawMessage(`{}`)); err != nil {
		t.Fatalf("teardown must be allowed in read-only mode: %v", err)
	}
}

// 只读模式下清理类命令必须放行（连接/终端/任务取消）。
func TestCleanupCommandsAllowedInReadOnly(t *testing.T) {
	app := newTestApp(t)
	handlers := app.Handlers()
	if _, err := handlers["settings.set"](context.Background(), json.RawMessage(
		`{"settings":{"readOnly":true,"historyLimit":100,"sudoAllowlist":[],"quickCommands":[]}}`)); err != nil {
		t.Fatalf("enable readonly: %v", err)
	}
	cases := [][2]string{
		{"conn.close", `{"connectionId":"c_missing"}`},
		{"conn.cancel", `{"connectionId":"c_missing"}`},
		{"terminal.close", `{"sessionKey":"t_missing"}`},
		{"transfer.cancel", `{"taskId":"x_missing"}`},
		{"agent.taskCancel", `{"taskId":"bg_missing"}`},
	}
	for _, c := range cases {
		if _, err := handlers[c[0]](context.Background(), json.RawMessage(c[1])); err != nil {
			perr, ok := err.(*goplugin.Error)
			if ok && perr.Code == errReadOnly {
				t.Fatalf("%s must be allowed in read-only mode", c[0])
			}
		}
	}
}
