package plugin

import "context"

func (d *DataSourceDispatcher) dispatch(ctx context.Context, r DataSourceRequest) (any, error) {
	o := d.operations
	switch r.Operation {
	case "ping":
		if o.Ping != nil {
			return map[string]bool{"ok": true}, o.Ping(ctx, r)
		}
	case "query":
		if o.Query != nil {
			return normalizeDataSourceQuery(o.Query(ctx, r))
		}
	case "databases":
		if o.Databases != nil {
			values, err := o.Databases(ctx, r)
			return dataSourceArray("names", values, err)
		}
	case "tables":
		if o.Tables != nil {
			values, err := o.Tables(ctx, r)
			return dataSourceArray("names", values, err)
		}
	case "createStatement":
		if o.CreateStatement != nil {
			statement, err := o.CreateStatement(ctx, r)
			if err != nil {
				return nil, err
			}
			if statement == "" {
				return nil, ErrDataSourceResult
			}
			return map[string]string{"statement": statement}, nil
		}
	case "columns":
		if o.Columns != nil {
			values, err := o.Columns(ctx, r)
			return dataSourceArray("columns", values, err)
		}
	case "allColumns":
		if o.AllColumns != nil {
			values, err := o.AllColumns(ctx, r)
			return dataSourceArray("allColumns", values, err)
		}
	case "indexes":
		if o.Indexes != nil {
			values, err := o.Indexes(ctx, r)
			return dataSourceArray("indexes", values, err)
		}
	case "foreignKeys":
		if o.ForeignKeys != nil {
			values, err := o.ForeignKeys(ctx, r)
			return dataSourceArray("foreignKeys", values, err)
		}
	case "triggers":
		if o.Triggers != nil {
			values, err := o.Triggers(ctx, r)
			return dataSourceArray("triggers", values, err)
		}
	case "exec":
		if o.Exec != nil {
			result, err := o.Exec(ctx, r)
			if err != nil {
				return nil, err
			}
			if result.RowsAffected < 0 {
				return nil, ErrDataSourceResult
			}
			return map[string]any{"ok": true, "rowsAffected": result.RowsAffected}, nil
		}
	case "begin":
		if o.Begin != nil {
			id, err := o.Begin(ctx, r)
			if err != nil {
				return nil, err
			}
			if !dataSourceSessionPattern.MatchString(id) {
				return nil, ErrDataSourceResult
			}
			return map[string]any{"ok": true, "transactionId": id}, nil
		}
	case "commit":
		if o.Commit != nil {
			return map[string]bool{"ok": true}, o.Commit(ctx, r)
		}
	case "rollback":
		if o.Rollback != nil {
			return map[string]bool{"ok": true}, o.Rollback(ctx, r)
		}
	}
	return nil, ErrDataSourceUnsupported
}
