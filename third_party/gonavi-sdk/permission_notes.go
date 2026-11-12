package plugin

import (
	"errors"
	"strings"
	"unicode"
)

// ValidatePermissionNotes checks optional notes without granting permissions.
func ValidatePermissionNotes(manifest Manifest) error {
	if len(manifest.PermissionNotes) == 0 {
		return nil
	}
	granted := make(map[string]bool, len(manifest.Permissions))
	for _, permission := range manifest.Permissions {
		granted[permission] = true
	}
	if len(manifest.PermissionNotes) > len(granted) {
		return errors.New("permission note does not match a declared permission")
	}
	for key, note := range manifest.PermissionNotes {
		if !granted[key] || !plainPermissionNote(note) {
			return errors.New("invalid permission note")
		}
	}
	return nil
}

func plainPermissionNote(note string) bool {
	if strings.TrimSpace(note) == "" || len(note) > 160 || strings.ContainsAny(note, "<>") {
		return false
	}
	for _, r := range note {
		if r < 0x20 || r == 0x7f || unicode.Is(unicode.Cc, r) {
			return false
		}
	}
	return true
}
