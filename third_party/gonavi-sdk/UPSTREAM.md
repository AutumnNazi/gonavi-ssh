# GoNavi Go SDK snapshot

Source: https://github.com/Syngnat/GoNavi/tree/982ecefe12b884c9075d12288302de46a625f91d/sdk/go

Commit: `982ecefe12b884c9075d12288302de46a625f91d` (2026-11-06).
License: Apache-2.0, copied from the upstream repository as `LICENSE`.

This directory contains the unmodified production `.go` files and `go.mod` from
that commit. Upstream tests are excluded because some require the upstream
repository's documentation and fixtures. The SDK has no external dependencies.

Keeping this 175 KiB snapshot makes a checkout build without another GoNavi
checkout or an unpublished SDK version. Do not patch the SDK here. To upgrade,
replace the production sources from one reviewed upstream commit, update this
record, and run the plugin tests and host package inspection.

For local development against another SDK, use an untracked Go workspace:

```sh
go work init . /path/to/GoNavi/sdk/go
```
