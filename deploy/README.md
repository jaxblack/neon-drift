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
                header /assets/* Cache-Control "public, max-age=31536000, immutable"
                header /index.html Cache-Control "no-cache"
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
2. rsync 到 `/srv/speed/releases/<git短hash>-<UTC时间戳>`
3. 原子切换 `current` 软链（`ln -sfn` + `mv -Tf`，切换过程中不会出现半个站点）
4. 只保留最近 5 个版本
5. curl 冒烟测试首页 + 主 JS 资源，非 200 直接失败

可用环境变量覆盖：`SSH_HOST`、`REMOTE_ROOT`、`BASE_PATH`、`PUBLIC_URL`、`KEEP_RELEASES`。

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
