package plugin

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
)

// safeFieldLabel renders a short printable field name and hides anything else.
func safeFieldLabel(name string) string {
	if len(name) == 0 || len(name) > 64 {
		return ""
	}
	for i := 0; i < len(name); i++ {
		if name[i] < 0x20 || name[i] > 0x7e {
			return ""
		}
	}
	return " \"" + name + "\""
}

func unknownFieldLabel(message string) string {
	start := strings.Index(message, "unknown field ")
	if start < 0 {
		return ""
	}
	return safeFieldLabel(strings.Trim(strings.TrimSpace(message[start+len("unknown field "):]), "\""))
}

// ParseManifest rejects oversized JSON, trailing values, and unknown fields.
// It does not replace host validation. Run plugin check before distributing a package.
func ParseManifest(data []byte) (Manifest, error) {
	var manifest Manifest
	if len(data) > 1<<20 {
		return manifest, errors.New("manifest exceeds size limit")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		if strings.Contains(err.Error(), "unknown field") {
			return manifest, errors.New("unknown manifest field" + unknownFieldLabel(err.Error()))
		}
		return manifest, errors.New("invalid manifest JSON")
	}
	var extra any
	if !errors.Is(decoder.Decode(&extra), io.EOF) {
		return manifest, errors.New("manifest has trailing data")
	}
	return manifest, nil
}
