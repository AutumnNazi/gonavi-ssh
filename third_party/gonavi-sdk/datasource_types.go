package plugin

import "context"

// DataSourceProtocolVersion identifies the read-only driver command contract.
const DataSourceProtocolVersion = 1

// DataSourceWriteProtocolVersion adds exec, begin, commit and rollback with an explicit transaction id.
const DataSourceWriteProtocolVersion = 2

// DataSourceConfig contains only the selected connection's necessary fields. Never log this value.
type DataSourceConfig struct {
	Host             string `json:"host"`
	Port             int    `json:"port"`
	User             string `json:"user"`
	Password         string `json:"password"`
	Database         string `json:"database"`
	ConnectionParams string `json:"connectionParams,omitempty"`
}

// DataSourceRequest identifies one operation and one host-owned, generation-bound session.
type DataSourceRequest struct {
	ProtocolVersion int               `json:"protocolVersion"`
	Operation       string            `json:"operation"`
	SessionID       string            `json:"sessionId"`
	Config          *DataSourceConfig `json:"config,omitempty"`
	Database        string            `json:"database,omitempty"`
	Table           string            `json:"table,omitempty"`
	Query           string            `json:"query,omitempty"`
	TransactionID   string            `json:"transactionId,omitempty"`
}

// DataSourceExecResult reports the affected-row count of one write statement.
type DataSourceExecResult struct {
	RowsAffected int64 `json:"rowsAffected"`
}

// DataSourceTransactionID is the provider-assigned opaque transaction handle, at most 128 ASCII characters.
type DataSourceTransactionID = string

// DataSourceQueryResult is a bounded single result set; use strings or json.Number for precise large numbers.
type DataSourceQueryResult struct {
	Rows   []map[string]any `json:"rows"`
	Fields []string         `json:"fields"`
}

// DataSourceColumnDefinition matches the host column metadata wire shape.
type DataSourceColumnDefinition struct {
	Name       string  `json:"name"`
	Type       string  `json:"type"`
	Nullable   string  `json:"nullable"`
	Key        string  `json:"key"`
	Default    *string `json:"default"`
	HasDefault bool    `json:"hasDefault,omitempty"`
	Extra      string  `json:"extra"`
	Comment    string  `json:"comment"`
	Charset    string  `json:"charset,omitempty"`
	Collation  string  `json:"collation,omitempty"`
}

// DataSourceColumnDefinitionWithTable is the separate allColumns autocomplete shape.
type DataSourceColumnDefinitionWithTable struct {
	TableName string `json:"tableName"`
	Name      string `json:"name"`
	Type      string `json:"type"`
	Comment   string `json:"comment,omitempty"`
}

// DataSourceIndexDefinition describes one indexed column, not a whole index.
type DataSourceIndexDefinition struct {
	Name       string `json:"name"`
	ColumnName string `json:"columnName"`
	NonUnique  int    `json:"nonUnique"`
	SeqInIndex int    `json:"seqInIndex"`
	IndexType  string `json:"indexType"`
	SubPart    int    `json:"subPart,omitempty"`
}

// DataSourceForeignKeyDefinition matches the host foreign-key metadata wire shape.
type DataSourceForeignKeyDefinition struct {
	Name           string `json:"name"`
	ColumnName     string `json:"columnName"`
	RefTableName   string `json:"refTableName"`
	RefColumnName  string `json:"refColumnName"`
	ConstraintName string `json:"constraintName"`
}

// DataSourceTriggerDefinition is read-only trigger metadata; it does not execute its statement.
type DataSourceTriggerDefinition struct {
	Name        string `json:"name"`
	Timing      string `json:"timing"`
	Event       string `json:"event"`
	Statement   string `json:"statement"`
	Orientation string `json:"orientation,omitempty"`
}

// DataSourceOperations supplies provider callbacks. Missing callbacks fail explicitly.
// Callbacks can run concurrently, must honor context cancellation, and must not log configs or secrets.
// Close must be idempotent: uncertain or late Connect completion can require a second cleanup call.
type DataSourceOperations struct {
	Connect         func(context.Context, DataSourceRequest) error
	Ping            func(context.Context, DataSourceRequest) error
	Close           func(context.Context, DataSourceRequest) error
	Query           func(context.Context, DataSourceRequest) (DataSourceQueryResult, error)
	Databases       func(context.Context, DataSourceRequest) ([]string, error)
	Tables          func(context.Context, DataSourceRequest) ([]string, error)
	CreateStatement func(context.Context, DataSourceRequest) (string, error)
	Columns         func(context.Context, DataSourceRequest) ([]DataSourceColumnDefinition, error)
	AllColumns      func(context.Context, DataSourceRequest) ([]DataSourceColumnDefinitionWithTable, error)
	Indexes         func(context.Context, DataSourceRequest) ([]DataSourceIndexDefinition, error)
	ForeignKeys     func(context.Context, DataSourceRequest) ([]DataSourceForeignKeyDefinition, error)
	Triggers        func(context.Context, DataSourceRequest) ([]DataSourceTriggerDefinition, error)
	Exec            func(context.Context, DataSourceRequest) (DataSourceExecResult, error)
	Begin           func(context.Context, DataSourceRequest) (string, error)
	Commit          func(context.Context, DataSourceRequest) error
	Rollback        func(context.Context, DataSourceRequest) error
}
