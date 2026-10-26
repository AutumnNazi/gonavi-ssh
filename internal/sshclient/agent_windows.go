//go:build windows

package sshclient

import (
	"github.com/Microsoft/go-winio"
	"golang.org/x/crypto/ssh/agent"
)

// windowsAgentPipe 是 Windows OpenSSH 代理服务的默认命名管道。
const windowsAgentPipe = `\\.\pipe\openssh-ssh-agent`

// dialAgent 连接 Windows 的 OpenSSH Agent 服务（命名管道）。
func dialAgent() (agent.Agent, error) {
	conn, err := winio.DialPipe(windowsAgentPipe, nil)
	if err != nil {
		return nil, err
	}
	return agent.NewClient(conn), nil
}
