## verifier 升级指南

本次升级，采用 docker 的方式启动，可以将 eth 和 bsc 部署在同一台服务器上，分别开启 8020、8021 端口的防火墙白名单访问

1. 进入 root，`sudo su -`

2. 找到当前的 keystore.json 文件，以及 force_bridge.json 文件，拷贝到当前目录下，将 eth 和 bsc 的文件分别命名为 `keystore_bsc.json`, `force_bridge_bsc.json`, `keystore_eth.json`, `force_bridge_eth.json`

3. 执行 `curl -sSL https://raw.githubusercontent.com/Magickbase/force-bridge/latest/deploy.sh | sudo FORCE_BRIDGE_KEYSTORE_PASSWORD=你的密码 MYSQL_ROOT_PASSWORD=你的MySQL密码 sh`

4. 执行 `docker ps -a` 查看是否启动成功