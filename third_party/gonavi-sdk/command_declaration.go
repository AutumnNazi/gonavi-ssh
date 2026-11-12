package plugin

import (
	"encoding/json"
	"errors"
	"regexp"
	"strings"
)

var commandIDPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$`)

// ValidateCommand checks the public command declaration before a plugin is packaged.
// It does not grant the effect. Data sources still cannot point at a write command.
func ValidateCommand(command Command) error {
	if !commandIDPattern.MatchString(command.ID) {
		return errors.New("invalid command id")
	}
	if strings.TrimSpace(command.Title) == "" || len(command.Title) > 256 || strings.ContainsRune(command.Title, 0) {
		return errors.New("invalid command title")
	}
	if len(command.Description) > 4096 {
		return errors.New("invalid command description")
	}
	if command.Effect != "" && command.Effect != "read" && command.Effect != "write" && command.Effect != "unknown" {
		return errors.New("unsupported command effect")
	}
	if len(command.InputSchema) == 0 {
		return nil
	}
	if len(command.InputSchema) > 64<<10 || !json.Valid(command.InputSchema) {
		return errors.New("invalid command schema")
	}
	var object map[string]any
	if json.Unmarshal(command.InputSchema, &object) != nil || object == nil {
		return errors.New("invalid command schema")
	}
	return nil
}
