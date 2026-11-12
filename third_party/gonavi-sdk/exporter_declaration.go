package plugin

import (
	"errors"
	"regexp"
	"strings"
	"unicode/utf8"
)

var exporterDeclarationID = regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,63}$`)
var exporterDeclarationExtension = regexp.MustCompile(`^[a-z0-9]{1,16}$`)
var exporterDeclarationType = regexp.MustCompile(`^(text|application)/[a-z0-9][a-z0-9.+-]{0,63}$`)

// ValidateExporter checks public snapshot-renderer metadata. It does not grant a filesystem path
// or prove that the command is declared on a backend.
func ValidateExporter(exporter Exporter) error {
	if !exporterDeclarationID.MatchString(exporter.ID) || exporter.Command == "" || !utf8.ValidString(exporter.Name) || strings.TrimSpace(exporter.Name) == "" || len(exporter.Name) > 256 || strings.ContainsRune(exporter.Name, 0) {
		return errors.New("invalid exporter identity")
	}
	if !exporterDeclarationExtension.MatchString(exporter.Extension) || !exporterDeclarationType.MatchString(exporter.ContentType) {
		return errors.New("invalid exporter extension or content type")
	}
	return nil
}
