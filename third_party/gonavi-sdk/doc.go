// Package plugin implements the independent GoNavi plugin protocol v1.
//
// The SDK imports only the standard library. Handlers run concurrently and must
// honor their contexts. Stdout belongs exclusively to JSON-RPC; diagnostic
// output belongs on stderr and must not contain credentials or connection data.
package plugin
