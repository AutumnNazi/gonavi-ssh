package plugin

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"regexp"
	"strings"
	"unicode/utf8"
)

var exporterLocalID = regexp.MustCompile(`^[a-z][a-z0-9_.-]{0,63}$`)
var exporterNumber = regexp.MustCompile(`^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$`)

func decodeExporterRequest(ctx context.Context, raw json.RawMessage) (ExporterRequest, error) {
	var request ExporterRequest
	if len(raw) > ExporterMaxEnvelopeBytes {
		return request, exporterError("limit_exceeded")
	}
	budget := exportJSONBudget{}
	if err := scanExporterJSON(ctx, raw, 0, &budget); err != nil {
		return request, err
	}
	object, err := exporterObjectOptional(raw, []string{"protocolVersion", "exporterId", "columns", "rows"}, []string{"chunkIndex", "chunkCount"})
	if err != nil {
		return request, err
	}
	if json.Unmarshal(raw, &request) != nil || !exporterLocalID.MatchString(request.ExporterID) {
		return request, exporterError("invalid_request")
	}
	rowLimit, cellLimit := 4096, 16384
	switch request.ProtocolVersion {
	case 1:
		if request.ChunkIndex != nil || request.ChunkCount != nil {
			return request, exporterError("invalid_request")
		}
	case 2:
		if request.ChunkIndex == nil || request.ChunkCount == nil || *request.ChunkCount < 1 || *request.ChunkIndex < 0 || *request.ChunkIndex >= *request.ChunkCount || *request.ChunkCount > 1<<20 {
			return request, exporterError("invalid_request")
		}
		rowLimit, cellLimit = ExporterChunkRows, 131072
	default:
		return request, exporterError("invalid_request")
	}
	if request.Columns == nil || len(request.Columns) == 0 || len(request.Columns) > 256 || request.Rows == nil || len(request.Rows) > rowLimit || len(request.Rows)*len(request.Columns) > cellLimit {
		return request, exporterError("invalid_request")
	}
	names := make(map[string]bool, len(request.Columns))
	for _, name := range request.Columns {
		if !utf8.ValidString(name) || len(name) > 1024 || strings.TrimSpace(name) == "" || strings.ContainsRune(name, 0) || names[name] {
			return request, exporterError("invalid_request")
		}
		names[name] = true
	}
	var rows [][]json.RawMessage
	if json.Unmarshal(object["rows"], &rows) != nil {
		return request, exporterError("invalid_request")
	}
	for rowIndex, row := range rows {
		if row == nil || len(row) != len(request.Columns) {
			return request, exporterError("invalid_request")
		}
		for column, rawCell := range row {
			cell := request.Rows[rowIndex][column]
			required := []string{"kind"}
			if cell.Kind != ExporterMissing && cell.Kind != ExporterNull {
				required = append(required, "value")
			}
			if _, err := exporterObject(rawCell, required...); err != nil {
				return request, err
			}
			if cell.Kind == ExporterJSON {
				budget.nodes--
			} // Replace the wire string node with its logical JSON value.
			if err := validateExporterCell(ctx, cell, &budget); err != nil {
				return request, err
			}
		}
	}
	return request, nil
}

func validateExporterCell(ctx context.Context, cell ExporterCell, budget *exportJSONBudget) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if cell.Kind == ExporterMissing || cell.Kind == ExporterNull {
		if cell.Value != nil {
			return exporterError("invalid_request")
		}
		return nil
	}
	if cell.Value == nil || !utf8.ValidString(*cell.Value) || len(*cell.Value) > 128<<10 {
		return exporterError("invalid_request")
	}
	value := *cell.Value
	switch cell.Kind {
	case ExporterString:
		return nil
	case ExporterBoolean:
		if value != "true" && value != "false" {
			return exporterError("invalid_request")
		}
	case ExporterNumber:
		if len(value) > 256 || !exporterNumber.MatchString(value) {
			return exporterError("invalid_request")
		}
	case ExporterJSON:
		if err := scanExporterJSON(ctx, []byte(value), 4, budget); err != nil {
			return err
		}
	case ExporterBinary:
		decoded, err := base64.StdEncoding.Strict().DecodeString(value)
		if err != nil || base64.StdEncoding.EncodeToString(decoded) != value {
			return exporterError("invalid_request")
		}
	default:
		return exporterError("invalid_request")
	}
	return nil
}

func validateExporterChunkResult(ctx context.Context, exporterID string, index int, text string, rowCount int) (ExporterChunkResult, error) {
	result := ExporterChunkResult{ProtocolVersion: 2, ExporterID: exporterID, ChunkIndex: index, RowCount: rowCount, Text: text}
	if err := ctx.Err(); err != nil {
		return ExporterChunkResult{}, err
	}
	if len(text) > ExporterMaxEnvelopeBytes || !utf8.ValidString(text) || strings.ContainsRune(text, 0) {
		return ExporterChunkResult{}, exporterError("invalid_result")
	}
	encoded, err := json.Marshal(result)
	if err != nil || len(encoded) > ExporterMaxEnvelopeBytes {
		return ExporterChunkResult{}, exporterError("limit_exceeded")
	}
	return result, nil
}

func validateExporterResult(ctx context.Context, text string, rowCount int) (ExporterResult, error) {
	result := ExporterResult{ProtocolVersion: 1, RowCount: rowCount, Text: text}
	if err := ctx.Err(); err != nil {
		return ExporterResult{}, err
	}
	if len(text) > ExporterMaxEnvelopeBytes || !utf8.ValidString(text) || strings.ContainsRune(text, 0) || (rowCount > 0 && text == "") {
		return ExporterResult{}, exporterError("invalid_result")
	}
	encoded, err := json.Marshal(result)
	if err != nil || len(encoded) > ExporterMaxEnvelopeBytes {
		return ExporterResult{}, exporterError("limit_exceeded")
	}
	return result, nil
}
