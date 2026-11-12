package terminal

import "testing"

func TestHistorySettingsClearAndStopRecording(t *testing.T) {
	manager := NewManager(10)
	session := newTestSession()
	session.histMax = 10
	manager.sessions[session.Key] = session
	_, _ = session.Write([]byte("old command\rpartial"))
	manager.SetHistory(false, 10)
	_, _ = session.Write([]byte("secret input without newline"))
	if len(session.History(0)) != 0 || len(session.lineBuf) != 0 || session.histEsc != 0 || session.suppressNext {
		t.Fatal("disabled history retained input")
	}
	if manager.histLimit != 0 {
		t.Fatal("new sessions would still record history")
	}
	manager.SetHistory(true, 2)
	_, _ = session.Write([]byte("one\rtwo\rthree\r"))
	got := session.History(0)
	if len(got) != 2 || got[0] != "two" || got[1] != "three" {
		t.Fatalf("history=%q", got)
	}
	manager.SetHistory(true, 1)
	if got := session.History(0); len(got) != 1 || got[0] != "three" {
		t.Fatalf("history=%q", got)
	}
}
