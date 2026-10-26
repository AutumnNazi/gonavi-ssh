package transfer

import (
	"errors"
	"fmt"
)

func checkLocalPaths(dir Direction, localPath string, allowLocalPath func(string) bool) error {
	if allowLocalPath == nil {
		return errors.New("local path admission is required")
	}
	paths := []string{localPath}
	switch dir {
	case Download:
		paths = append(paths, localPath+".part", localPath+".part.meta")
	case Upload:
	default:
		return errors.New("direction must be upload or download")
	}
	for _, path := range paths {
		if !allowLocalPath(path) {
			return fmt.Errorf("local path is outside the configured localPathAllowlist: %s", path)
		}
	}
	return nil
}
