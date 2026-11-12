package plugin

import (
	"errors"
	"path"
	"strings"
)

// ValidateSkillResources checks optional companion markdown paths. It does not grant execution.
func ValidateSkillResources(skill Skill) error {
	if !plainSkillEntry(skill.Entry) {
		return errors.New("invalid skill entry")
	}
	if len(skill.Resources) > 4 {
		return errors.New("too many skill resources")
	}
	seen := map[string]bool{skill.Entry: true}
	for _, resource := range skill.Resources {
		if seen[resource] || !plainSkillResource(resource) {
			return errors.New("invalid skill resource")
		}
		seen[resource] = true
	}
	return nil
}

func plainSkillEntry(entry string) bool {
	if entry == "" || len(entry) > 1024 || strings.Contains(entry, "..") || skillPathForbidden(entry) || path.IsAbs(entry) || path.Clean(entry) != entry || !skillPathSegmentsOK(entry) {
		return false
	}
	return path.Base(entry) == "SKILL.md"
}

func skillPathForbidden(value string) bool {
	if strings.ContainsAny(value, "\\:\x00<>\"|?*") {
		return true
	}
	for _, char := range value {
		if char < 32 {
			return true
		}
	}
	return false
}

func skillPathSegmentsOK(value string) bool {
	if strings.Count(value, "/") > 32 {
		return false
	}
	for _, part := range strings.Split(value, "/") {
		if len(part) > 240 || strings.TrimRight(part, " .") != part || skillSegmentReserved(part) {
			return false
		}
	}
	return true
}

func skillSegmentReserved(part string) bool {
	base := strings.ToUpper(strings.SplitN(part, ".", 2)[0])
	switch base {
	case "CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$":
		return true
	}
	if !strings.HasPrefix(base, "COM") && !strings.HasPrefix(base, "LPT") {
		return false
	}
	suffix := base[3:]
	return len(suffix) == 1 && suffix[0] >= '0' && suffix[0] <= '9' || suffix == "¹" || suffix == "²" || suffix == "³"
}

func plainSkillResource(resource string) bool {
	if resource == "" || len(resource) > 1024 || strings.Contains(resource, "..") || skillPathForbidden(resource) {
		return false
	}
	return path.Ext(resource) == ".md" && path.Base(resource) != "SKILL.md" && path.Clean(resource) == resource && !path.IsAbs(resource) && skillPathSegmentsOK(resource)
}
