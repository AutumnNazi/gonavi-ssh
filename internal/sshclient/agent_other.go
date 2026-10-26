//go:build !windows

package sshclient

import (
	"errors"
	"net"
	"os"

	"golang.org/x/crypto/ssh/agent"
)

// dialAgent 连接 Unix 域套接字上的 ssh-agent（SSH_AUTH_SOCK）。
func dialAgent() (agent.Agent, error) {
	sock := os.Getenv("SSH_AUTH_SOCK")
	if sock == "" {
		return nil, errors.New("SSH_AUTH_SOCK is not set")
	}
	conn, err := net.Dial("unix", sock)
	if err != nil {
		return nil, err
	}
	return agent.NewClient(conn), nil
}
