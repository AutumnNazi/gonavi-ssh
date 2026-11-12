module gonavi-ssh

go 1.26.0

require (
	github.com/Microsoft/go-winio v0.6.4
	github.com/Syngnat/GoNavi/sdk/go v0.0.0
	golang.org/x/crypto v0.54.0
)

require (
	github.com/kr/fs v0.1.0 // indirect
	github.com/pkg/sftp v1.13.12 // indirect
	golang.org/x/sys v0.49.0 // indirect
)

// 固定的上游源码快照；来源和更新方式见 third_party/gonavi-sdk/UPSTREAM.md。
replace github.com/Syngnat/GoNavi/sdk/go => ./third_party/gonavi-sdk
