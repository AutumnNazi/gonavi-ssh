package main

import "testing"

// 数据目录优先级：GONAVI_SSH_HOME > GONAVI_PLUGIN_DATA > 用户目录兜底。
// 回归背景：宿主以受限环境启动插件进程（无 USERPROFILE），依赖
// os.UserHomeDir 会导致进程启动即退出。
func TestResolveDataDirPriority(t *testing.T) {
	t.Setenv("GONAVI_SSH_HOME", "/custom/home")
	t.Setenv("GONAVI_PLUGIN_DATA", "/plugin/data")
	got, err := resolveDataDir()
	if err != nil || got != "/custom/home" {
		t.Fatalf("GONAVI_SSH_HOME must win: got %q err %v", got, err)
	}

	t.Setenv("GONAVI_SSH_HOME", "")
	got, err = resolveDataDir()
	if err != nil || got != "/plugin/data" {
		t.Fatalf("GONAVI_PLUGIN_DATA must be used when no override: got %q err %v", got, err)
	}
}

// 两个覆盖都缺省时，正常桌面环境应回落到用户目录（不报错）。
func TestResolveDataDirFallsBackToHome(t *testing.T) {
	t.Setenv("GONAVI_SSH_HOME", "")
	t.Setenv("GONAVI_PLUGIN_DATA", "")
	got, err := resolveDataDir()
	if err != nil {
		t.Fatalf("fallback failed: %v", err)
	}
	if got == "" {
		t.Fatal("empty data dir")
	}
}
