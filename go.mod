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

// 本地开发：指向本机 GoNavi 仓库的 SDK。发布前可改为版本号或保留 replace。
replace github.com/Syngnat/GoNavi/sdk/go => E:/code/GoNavi/sdk/go
