package plugin

import (
	"encoding/base64"
	"strings"
)

// Host image content parts are self-contained base64 data URLs on user messages.
// The dispatcher rejects remote URLs, so a plugin never receives a fetch target.
const (
	aiProviderMaxImageRequestBytes = 32 << 20
	aiProviderMaxImageDecodedBytes = 4 << 20
	aiProviderMaxImagesPerMessage  = 4
	aiProviderMaxRequestImageBytes = 24 << 20
)

// AIProviderImageFrameBytes is the frame budget a plugin must grant itself when
// it declares supportsImages. A default server keeps the text-only one MiB frame.
const AIProviderImageFrameBytes = aiProviderMaxImageRequestBytes

var aiProviderImageMediaTypes = map[string]bool{
	"image/png":  true,
	"image/jpeg": true,
	"image/webp": true,
	"image/gif":  true,
}

func aiProviderRequestHasImages(request AIProviderRequest) bool {
	for _, message := range request.Messages {
		if len(message.Images) > 0 {
			return true
		}
	}
	return false
}

func validateAIProviderImages(messages []AIProviderMessage, supportsImages bool) error {
	total := 0
	for _, message := range messages {
		if len(message.Images) == 0 {
			continue
		}
		if !supportsImages || message.Role != "user" || len(message.Images) > aiProviderMaxImagesPerMessage {
			return aiProviderFailure("unsupported")
		}
		for _, image := range message.Images {
			if !aiProviderImageDataURL(image) {
				return aiProviderFailure("invalid_request")
			}
			total += len(image)
			if total > aiProviderMaxRequestImageBytes {
				return aiProviderFailure("limit_exceeded")
			}
		}
	}
	return nil
}

func aiProviderImageDataURL(value string) bool {
	header, payload, ok := strings.Cut(value, ",")
	if !ok || payload == "" || !strings.HasPrefix(header, "data:") || !strings.HasSuffix(header, ";base64") {
		return false
	}
	mediaType := strings.TrimSuffix(strings.TrimPrefix(header, "data:"), ";base64")
	if !aiProviderImageMediaTypes[mediaType] {
		return false
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(payload)
	return err == nil && len(decoded) > 0 && len(decoded) <= aiProviderMaxImageDecodedBytes
}
