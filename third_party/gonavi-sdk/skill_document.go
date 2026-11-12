package plugin

import (
	"bytes"
	"errors"
	"unicode/utf8"
)

const maxSkillDocumentBytes = 64 << 10

// ValidateSkillDocument checks captured markdown bytes before packaging.
// It does not execute the document or grant tools.
func ValidateSkillDocument(content []byte) error {
	if len(content) == 0 || len(content) > maxSkillDocumentBytes {
		return errors.New("skill document is empty or exceeds size limit")
	}
	if !utf8.Valid(content) || bytes.Contains(content, []byte{0}) {
		return errors.New("skill document must be UTF-8 text without NUL")
	}
	return nil
}
