package agentcmd

import (
	"testing"
)

func TestParseLoad(t *testing.T) {
	got := parseLoad(" 21:33:52 up 5 days,  3:14,  2 users,  load average: 0.08, 0.12, 0.09")
	if got == nil || len(got) != 3 {
		t.Fatalf("got %v", got)
	}
	if got[0] != 0.08 || got[1] != 0.12 || got[2] != 0.09 {
		t.Fatalf("values %v", got)
	}
	if parseLoad("no load here") != nil {
		t.Fatal("expected nil for text without load average")
	}
}

func TestParseFreeMem(t *testing.T) {
	block := "               total        used        free      shared  buff/cache   available\nMem:       16165000     4200000     1000000      200000     9000000    11000000\n"
	mem := parseFreeMem(block)
	if mem == nil {
		t.Fatal("expected memory map")
	}
	if mem["total"] != 16165000 || mem["used"] != 4200000 || mem["available"] != 11000000 {
		t.Fatalf("mem %v", mem)
	}
}

func TestParseDf(t *testing.T) {
	block := `Filesystem     1B-blocks      Used Available Use% Mounted on
/dev/sda1      100000000  95000000   5000000  95% /
tmpfs          161650000         0 161650000   0% /dev/shm
/dev/sdb1      500000000 100000000 400000000  20% /data`
	rows := parseDf(block)
	if len(rows) != 3 {
		t.Fatalf("rows %d", len(rows))
	}
	// 排序：使用率降序。
	if rows[0].Mount != "/" || rows[0].UsePercent != 95 {
		t.Fatalf("first row %+v", rows[0])
	}
	if rows[2].Mount != "/dev/shm" {
		t.Fatalf("last row %+v", rows[2])
	}
}
