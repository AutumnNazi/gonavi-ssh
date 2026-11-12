package plugin

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"regexp"
	"strconv"
)

// ErrDataSourceRequest means the driver envelope is invalid; it never includes selected credentials.
var ErrDataSourceRequest = errors.New("invalid datasource request")

// ErrDataSourceUnsupported means the provider did not implement the requested read-only operation.
var ErrDataSourceUnsupported = errors.New("unsupported datasource operation")

// ErrDataSourceSession means a host session is unknown, closed, duplicated or not yet connected.
var ErrDataSourceSession = errors.New("datasource session unavailable")

// ErrDataSourceLimit means a request, response or dispatcher lifetime budget was exceeded.
var ErrDataSourceLimit = errors.New("datasource limit exceeded")

// ErrDataSourceResult means a callback returned an invalid shape rather than an explicit empty array.
var ErrDataSourceResult = errors.New("invalid datasource result")

var dataSourceSessionPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,128}$`)

func decodeDataSourceRequest(raw json.RawMessage) (DataSourceRequest, error) {
	var request DataSourceRequest
	if len(raw) > DefaultMaxFrameBytes {
		return request, ErrDataSourceLimit
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil {
		return request, ErrDataSourceRequest
	}
	var extra any
	if !errors.Is(decoder.Decode(&extra), io.EOF) {
		return request, ErrDataSourceRequest
	}
	if !dataSourceSessionPattern.MatchString(request.SessionID) {
		return request, ErrDataSourceRequest
	}
	if len(request.Database) > 1024 || len(request.Table) > 1024 || len(request.Query) > 256<<10 || len(request.TransactionID) > 128 {
		return request, ErrDataSourceLimit
	}
	if err := validateDataSourceOperation(request); err != nil {
		return request, err
	}
	var envelope map[string]json.RawMessage
	if json.Unmarshal(raw, &envelope) != nil {
		return request, ErrDataSourceRequest
	}
	for _, value := range envelope {
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return request, ErrDataSourceRequest
		}
	}
	if request.Config != nil {
		var config map[string]json.RawMessage
		if json.Unmarshal(envelope["config"], &config) != nil {
			return request, ErrDataSourceRequest
		}
		for _, value := range config {
			if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
				return request, ErrDataSourceRequest
			}
		}
	}
	return request, nil
}

func validateDataSourceOperation(request DataSourceRequest) error {
	switch request.ProtocolVersion {
	case DataSourceProtocolVersion:
		return validateDataSourceReadOperation(request)
	case DataSourceWriteProtocolVersion:
		return validateDataSourceWriteOperation(request)
	default:
		return ErrDataSourceRequest
	}
}

func validateDataSourceReadOperation(request DataSourceRequest) error {
	if request.TransactionID != "" {
		return ErrDataSourceRequest
	}
	switch request.Operation {
	case "connect":
		if request.Config == nil || request.Database != "" || request.Table != "" || request.Query != "" {
			return ErrDataSourceRequest
		}
		c := request.Config
		if c.Port < 0 || c.Port > 65535 || len(c.Host) > 1024 || len(c.User) > 1024 || len(c.Password) > 8192 || len(c.Database) > 1024 || len(c.ConnectionParams) > 16384 {
			return ErrDataSourceRequest
		}
	case "ping", "close", "databases", "tables", "query", "createStatement", "columns", "allColumns", "indexes", "foreignKeys", "triggers":
		if request.Config != nil {
			return ErrDataSourceRequest
		}
		if request.Operation == "query" && request.Query == "" {
			return ErrDataSourceRequest
		}
		if request.Operation != "query" && request.Query != "" {
			return ErrDataSourceRequest
		}
	default:
		return ErrDataSourceUnsupported
	}
	return nil
}

func validateDataSourceWriteOperation(request DataSourceRequest) error {
	if request.Config != nil || request.Database != "" || request.Table != "" {
		return ErrDataSourceRequest
	}
	switch request.Operation {
	case "begin":
		if request.TransactionID != "" || request.Query != "" {
			return ErrDataSourceRequest
		}
	case "query", "exec":
		if !dataSourceSessionPattern.MatchString(request.TransactionID) || request.Query == "" {
			return ErrDataSourceRequest
		}
	case "commit", "rollback":
		if !dataSourceSessionPattern.MatchString(request.TransactionID) || request.Query != "" {
			return ErrDataSourceRequest
		}
	default:
		return ErrDataSourceUnsupported
	}
	return nil
}

func dataSourceArray[T any](key string, values []T, err error) (any, error) {
	if err != nil {
		return nil, err
	}
	if values == nil {
		return nil, ErrDataSourceResult
	}
	if len(values) > 10000 {
		return nil, ErrDataSourceLimit
	}
	return map[string]any{key: values}, nil
}

func boundedDataSourceResult(value any, err error) (any, error) {
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, ErrDataSourceResult
	}
	if len(encoded) > DefaultMaxFrameBytes {
		return nil, ErrDataSourceLimit
	}
	return value, nil
}

func normalizeDataSourceQuery(result DataSourceQueryResult, err error) (any, error) {
	if err != nil {
		return nil, err
	}
	if result.Rows == nil || result.Fields == nil {
		return nil, ErrDataSourceResult
	}
	if len(result.Rows) > 10000 || len(result.Fields) > 512 {
		return nil, ErrDataSourceLimit
	}
	fields := make(map[string]bool, len(result.Fields))
	for _, field := range result.Fields {
		if field == "" || len(field) > 1024 || fields[field] {
			return nil, ErrDataSourceResult
		}
		fields[field] = true
	}
	for _, row := range result.Rows {
		if row == nil || len(row) != len(fields) {
			return nil, ErrDataSourceResult
		}
		for key := range row {
			if !fields[key] {
				return nil, ErrDataSourceResult
			}
		}
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		return nil, ErrDataSourceResult
	}
	if len(encoded) > DefaultMaxFrameBytes {
		return nil, ErrDataSourceLimit
	}
	// Round-trip into private JSON containers to avoid mutating callback-owned data.
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var value any
	if decoder.Decode(&value) != nil {
		return nil, ErrDataSourceResult
	}
	return normalizeDataSourceNumbers(value), nil
}

func normalizeDataSourceNumbers(value any) any {
	switch typed := value.(type) {
	case json.Number:
		number, err := strconv.ParseFloat(typed.String(), 64)
		if err != nil || math.Abs(number) > 9007199254740991 {
			return typed.String()
		}
	case map[string]any:
		for key, element := range typed {
			typed[key] = normalizeDataSourceNumbers(element)
		}
	case []any:
		for index, element := range typed {
			typed[index] = normalizeDataSourceNumbers(element)
		}
	}
	return value
}
