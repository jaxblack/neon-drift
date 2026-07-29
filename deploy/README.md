# 部署

线上地址：<https://qlili.com/speed>

## 一次性准备（服务器侧）

站点由腾讯云上的 Caddy 托管，和同机的 `besthome` 共用 `qlili.com` 这个站点块。

### 1. 建目录

```bash
ssh tencent-main
sudo mkdir -p /srv/speed/releases
sudo chown -R "$USER:$USER" /srv/speed
```

### 2. 加 Caddy 路由

编辑 `/etc/caddy/Caddyfile`，在 `qlili.com, www.qlili.com { ... }` 块内加：

```caddyfile
        redir /speed /speed/ 308

        handle_path /speed/* {
                root * /srv/speed/current
                file_server

                # handle_path 剥掉了 /speed 前缀，所以访问 /speed/ 时这里的路径是 /。
                # 只写 /index.html 的话入口页匹配不上，会被浏览器长缓存住。
                @html path / /index.html
                header @html Cache-Control "no-cache"

                # 资源名带 content hash，可以放心长缓存
                header /assets/* Cache-Control "public, max-age=31536000, immutable"
        }
```

`handle_path` 会剥掉 `/speed` 前缀，所以 `/speed/assets/x.js` 对应
`/srv/speed/current/assets/x.js`。

改完校验并热重载（**不要**用 restart，会断当前连接）：

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

## 日常发布

```bash
bash deploy/deploy.sh
```

脚本做的事：

1. `VITE_BASE_PATH=/speed/ npm run build`，并校验产物里确实带了 `/speed/assets/` 前缀
   （base 没生效的话线上会整页 404，所以这步是硬断言）
2. `tar` 打包后 scp 到 `/srv/speed/releases/<git短hash>-<UTC时间戳>` 并解压
   （用 tar 而不是 rsync —— Windows 的 Git Bash 没有 rsync）
3. 原子切换 `current` 软链（`ln -sfn` + `mv -Tf`，切换过程中不会出现半个站点）
4. 只保留最近 5 个版本
5. curl 冒烟测试首页 + 主 JS 资源，非 200 直接失败

可用环境变量覆盖：`SSH_HOST`、`REMOTE_ROOT`、`BASE_NAME`、`SITE`、`KEEP_RELEASES`。

Windows 上用 Git Bash 跑：

```powershell
& "C:\Program Files\Git\bin\bash.exe" deploy/deploy.sh
```

> **`BASE_NAME` 不要带斜杠。** Git Bash (MSYS) 会把以 `/` 开头的环境变量当成 POSIX
> 路径，自动展开成 `C:/Program Files/Git/speed`，构建出来的资源路径线上必然 404。
> 踩过一次：因为旧的断言是 `grep "/speed/assets/"`，而被污染的
> `/Program Files/Git/speed/assets/` 恰好包含这个子串，断言被静默绕过，
> 一直到线上白屏才发现。现在改成精确比对前缀，并且冒烟测试直接从线上 HTML 取路径。

## 回滚

```bash
ssh tencent-main
ls -1dt /srv/speed/releases/*/        # 找上一个版本
ln -sfn /srv/speed/releases/<上个版本> /srv/speed/current.new
mv -Tf /srv/speed/current.new /srv/speed/current
```

纯静态站，不需要重启任何服务。

## 说明

- 游戏是**纯静态**的，没有后端依赖。`server/index.mjs` 是联机功能的骨架，
  目前不参与部署；等联机做完再在 Caddy 里加 `/speed/ws` 的 reverse_proxy。
- 所有贴图和音效都是运行时生成的，产物只有 `index.html` + 一个 JS + 一个 CSS，
  gzip 后约 170 KB。
