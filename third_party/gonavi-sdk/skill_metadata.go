package plugin

import (
	"errors"
	"strings"
	"unicode/utf8"
)

// ValidateSkillMetadata checks the public name and description byte limits. It does not grant tools.
func ValidateSkillMetadata(skill Skill) error {
	if !declaredSkillText(skill.Name, 256) {
		return errors.New("invalid skill name")
	}
	if !declaredSkillText(skill.Description, 2048) {
		return errors.New("invalid skill description")
	}
	return nil
}

func declaredSkillText(value string, limit int) bool {
	return utf8.ValidString(value) && len(value) <= limit && strings.TrimSpace(value) != "" && !strings.ContainsRune(value, 0)
}
