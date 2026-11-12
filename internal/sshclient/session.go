package sshclient

import (
	"context"

	"golang.org/x/crypto/ssh"
)

// OpenSession bounds channel creation and optional PTY/shell setup together.
// SSH has no cancellation packet for a pending channel-open/request. If setup
// times out, retire that connection so the blocked operation and late handles
// are released, rather than accumulating goroutines on an unresponsive peer.
func (c *Conn) OpenSession(ctx context.Context, setup func(*ssh.Session) error) (*ssh.Session, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	type result struct {
		session *ssh.Session
		err     error
	}
	done := make(chan result)
	go func() {
		session, err := c.client.NewSession()
		if err == nil && setup != nil {
			err = setup(session)
		}
		select {
		case done <- result{session, err}:
		case <-ctx.Done():
			if session != nil {
				_ = session.Close()
			}
		}
	}()
	select {
	case res := <-done:
		if err := ctx.Err(); err != nil {
			c.dead.Store(true)
			go c.Close()
			if res.session != nil {
				go res.session.Close()
			}
			return nil, err
		}
		if res.err != nil && res.session != nil {
			go res.session.Close()
		}
		return res.session, res.err
	case <-ctx.Done():
		c.dead.Store(true)
		go c.Close()
		return nil, ctx.Err()
	}
}
