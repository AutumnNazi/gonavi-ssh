package server

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gonavi-ssh/internal/profile"
)

func TestDamagedStoredProfileCannotConnectOrTestAsDirectConnection(t *testing.T) {
	app := newTestApp(t)
	p, err := app.profiles.Upsert(profile.Profile{Name: "broken", Host: "127.0.0.1", User: "ops", AuthMethod: profile.AuthNone,
		Jumps: []profile.Jump{{Host: "jump.invalid", User: "ops", AuthMethod: profile.AuthAgent}}})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(app.dataDir, "secret.key")); err != nil {
		t.Fatal(err)
	}
	app.profiles, err = profile.Open(app.dataDir)
	if err != nil {
		t.Fatal(err)
	}
	damaged, _ := app.profiles.Get(p.ID)
	if !damaged.Sanitized().CorruptJumps {
		t.Fatal("jump corruption missing from sanitized profile")
	}
	for _, tc := range []struct {
		command string
		args    any
	}{
		{"conn.open", map[string]any{"profileId": p.ID}},
		{"profile.test", map[string]any{"profileId": p.ID}},
		{"profile.test", map[string]any{"profile": map[string]any{"id": p.ID, "name": "edited", "host": "127.0.0.1", "user": "ops", "authMethod": "none", "jumps": []any{}}}},
	} {
		raw, _ := json.Marshal(tc.args)
		result, err := app.Handlers()[tc.command](context.Background(), raw)
		message := ""
		if err != nil {
			message = err.Error()
		} else if value, ok := result.(map[string]any); ok {
			message, _ = value["error"].(string)
		}
		if !strings.Contains(message, "credentials") {
			t.Fatalf("%s was not rejected: result=%v err=%v", tc.command, result, err)
		}
	}
	if len(app.conns.Status("")) != 0 {
		t.Fatal("damaged profile started a connection")
	}
}
