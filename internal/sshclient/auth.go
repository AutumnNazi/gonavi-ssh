package sshclient

import (
	"errors"
	"fmt"
	"os"
	"strings"

	"golang.org/x/crypto/ssh"

	"gonavi-ssh/internal/profile"
)

// creds 是 Profile/Jump 共用的认证材料视图，主目标与每一跳都复用同一套构建逻辑。
type creds struct {
	User       string
	AuthMethod profile.AuthMethod
	KeyPath    string
	Password   string
	Passphrase string
}

// interactive 回调类型：键盘交互认证（TOTP/双因素）的服务端提问经此转发给
// UI，等待用户输入；nil 表示无人应答（自动回空串）。
type interactiveFunc func(stage string) ssh.KeyboardInteractiveChallenge

// buildAuthMethods 按声明的认证方式构造 ssh.AuthMethod 列表。
// 认证方式不越权：声明 password 就不偷试 agent，避免产生用户没预期的凭据来源。
func buildAuthMethods(c creds, interactive interactiveFunc, stage string) ([]ssh.AuthMethod, error) {
	var kb ssh.KeyboardInteractiveChallenge
	if interactive != nil {
		kb = interactive(stage)
	} else {
		// 无人交互（连通性测试）：回空答案，让服务端判定成败。
		kb = func(_, _ string, questions []string, _ []bool) ([]string, error) {
			return make([]string, len(questions)), nil
		}
	}
	switch c.AuthMethod {
	case profile.AuthPassword:
		return []ssh.AuthMethod{ssh.Password(c.Password), ssh.KeyboardInteractive(kb)}, nil

	case profile.AuthKey:
		keyBytes, err := os.ReadFile(strings.TrimSpace(c.KeyPath))
		if err != nil {
			return nil, fmt.Errorf("read private key: %w", err)
		}
		signer, err := ssh.ParsePrivateKey(keyBytes)
		if err != nil {
			// 带口令的私钥：用口令重试一次。
			signer, err = ssh.ParsePrivateKeyWithPassphrase(keyBytes, []byte(c.Passphrase))
			if err != nil {
				return nil, fmt.Errorf("parse private key (wrong passphrase?): %w", err)
			}
		}
		return []ssh.AuthMethod{ssh.PublicKeys(signer)}, nil

	case profile.AuthAgent:
		agentClient, err := dialAgent()
		if err != nil {
			return nil, fmt.Errorf("connect ssh agent: %w", err)
		}
		return []ssh.AuthMethod{ssh.PublicKeysCallback(agentClient.Signers)}, nil

	case profile.AuthNone:
		// 开放账号：空方法列表让 x/crypto 尝试 "none" 认证。
		return nil, nil

	default:
		return nil, errors.New("unsupported auth method")
	}
}
