package plugin

import "errors"

func (s *session) closeRoots() {
	s.rootCloseOnce.Do(func() {
		defer func() {
			if recover() != nil {
				s.recordFailure(errors.New("plugin close hook panicked"))
			}
		}()
		if s.options.OnClose != nil {
			s.options.OnClose()
		}
	})
}
