package plugin

import "context"

// ExporterMaxEnvelopeBytes bounds the complete encoded request or reply, not only row data.
const ExporterMaxEnvelopeBytes = 512 << 10

// ExporterChunkRows bounds one ordered streaming frame; the document total is unbounded.
const ExporterChunkRows = 512

// ExporterCellKind is an explicit data tag. Strings are never guessed to be JSON, numbers or binary.
type ExporterCellKind string

// Exporter cell tags preserve absent values separately from present nulls.
const (
	ExporterMissing ExporterCellKind = "missing"
	ExporterNull    ExporterCellKind = "null"
	ExporterString  ExporterCellKind = "string"
	ExporterBoolean ExporterCellKind = "boolean"
	ExporterNumber  ExporterCellKind = "number"
	ExporterJSON    ExporterCellKind = "json"
	ExporterBinary  ExporterCellKind = "binary"
)

// ExporterCell stores a string when value is present; missing/null must omit Value.
type ExporterCell struct {
	Kind  ExporterCellKind `json:"kind"`
	Value *string          `json:"value,omitempty"`
}

// ExporterSnapshot contains only selected columns in user order and their materialized cell values.
// A renderer owns this private snapshot and must not retain it after returning.
// ProtocolVersion 2 identifies one ordered chunk of a larger document; renderers emit headers,
// separators and footers according to ChunkIndex and ChunkCount.
type ExporterSnapshot struct {
	Columns         []string         `json:"columns"`
	Rows            [][]ExporterCell `json:"rows"`
	ProtocolVersion int              `json:"protocolVersion,omitempty"`
	ChunkIndex      int              `json:"chunkIndex,omitempty"`
	ChunkCount      int              `json:"chunkCount,omitempty"`
}

// ExporterRequest is the version-one one-shot or version-two ordered chunk envelope.
type ExporterRequest struct {
	ProtocolVersion int              `json:"protocolVersion"`
	ExporterID      string           `json:"exporterId"`
	Columns         []string         `json:"columns"`
	Rows            [][]ExporterCell `json:"rows"`
	ChunkIndex      *int             `json:"chunkIndex,omitempty"`
	ChunkCount      *int             `json:"chunkCount,omitempty"`
}

// ExporterResult contains document text only; destination paths remain host-owned.
type ExporterResult struct {
	ProtocolVersion int    `json:"protocolVersion"`
	RowCount        int    `json:"rowCount"`
	Text            string `json:"text"`
}

// ExporterChunkResult identifies exactly which ordered frame the text belongs to.
type ExporterChunkResult struct {
	ProtocolVersion int    `json:"protocolVersion"`
	ExporterID      string `json:"exporterId"`
	ChunkIndex      int    `json:"chunkIndex"`
	RowCount        int    `json:"rowCount"`
	Text            string `json:"text"`
}

// ExporterRender honors the single request context and returns text without filenames or filesystem work.
type ExporterRender func(context.Context, ExporterSnapshot) (string, error)

// NewExporterCell constructs and validates an explicitly tagged value without converting numeric lexemes.
// Missing/null require an empty argument and omit Value; an empty string cell retains Value.
func NewExporterCell(kind ExporterCellKind, value string) (ExporterCell, error) {
	cell := ExporterCell{Kind: kind}
	if kind != ExporterMissing && kind != ExporterNull {
		cell.Value = &value
	} else if value != "" {
		return cell, exporterError("invalid_request")
	}
	budget := exportJSONBudget{}
	if err := validateExporterCell(context.Background(), cell, &budget); err != nil {
		return ExporterCell{}, err
	}
	return cell, nil
}
