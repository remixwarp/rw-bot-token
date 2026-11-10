# rw-bot-token — GitHub API 写转发

前端（RemixWarp 编辑器「网络还原点」、rwc 各界面）不再内嵌 GitHub PAT：
所有仓库级 GitHub API 请求经本 Worker 转发，token 由服务端持有并注入。
只有 `ALLOWED_REPOS` 白名单里的仓库才能完成推送。

## 部署（Cloudflare Workers）

```bash
npm install -g wrangler
wrangler login
# 在本目录（含 wrangler.toml）执行：
wrangler deploy
# 配置 token（不要写进任何文件）：
npx wrangler secret put GH_TOKEN
```

按提示粘贴 PAT：

- classic PAT：需要 `repo` scope；
- fine-grained PAT：需要对白名单内每个仓库有 **Contents: Read and Write**。

部署完成后先自检：

```bash
curl https://<你的 Worker 域名>/health
# 期望：{"ok":true,"service":"rw-bot-token","tokenConfigured":true,"allowedRepos":["remixwarp/rwc","RemixWarp-rw/rw-owr"]}
```

> 也可以在 Dashboard 手动部署：Workers & Pages → Create Worker → 粘贴 `src/index.js`；
> Settings → Variables 添加 `ALLOWED_REPOS` / `ALLOWED_ORIGINS`；
> Settings → Secrets 添加 `GH_TOKEN`。

## 变量

| 变量 | 说明 | 默认值 |
|---|---|---|
| `GH_TOKEN`（Secret） | 用于推送的 GitHub PAT | 必填 |
| `ALLOWED_REPOS` | 允许推送的仓库白名单（逗号分隔，大小写不敏感） | `remixwarp/rwc,RemixWarp-rw/rw-owr` |
| `ALLOWED_ORIGINS` | CORS 来源白名单，`*` 放行所有来源 | `*` |

以后要给更多仓库开通推送：在 `ALLOWED_REPOS` 里追加 `owner/name` 后重新 `wrangler deploy`。

## API

- `GET /health`：状态与白名单（不含任何机密）。
- `ANY /api/:owner/:repo/<GitHub 路径>`：转发到
  `https://api.github.com/repos/:owner/:repo/<GitHub 路径>`，自动注入 Authorization。
  - 仅白名单仓库放行，其余 403；
  - `POST/PATCH/PUT` 仅限 `/git/blobs`、`/git/trees`、`/git/commits`、`/git/refs`、`/contents`；
  - `DELETE` 禁用。

### curl 示例

```bash
# 创建 blob
curl -X POST "https://<你的域名>/api/RemixWarp-rw/rw-owr/git/blobs" \
  -H 'Content-Type: application/json' \
  -d '{"content":"hello","encoding":"utf-8"}'

# 更新分支引用
curl -X PATCH "https://<你的域名>/api/RemixWarp-rw/rw-owr/git/refs/heads/main" \
  -H 'Content-Type: application/json' \
  -d '{"sha":"<new commit sha>","force":false}'
```

## 安全说明

- PAT 只存在于 Worker 的加密 Secret 中，不出现在任何前端代码或仓库里。
- 白名单外的仓库一律 403；写路径受限；`DELETE` 禁用。
- `ALLOWED_ORIGINS` 建议尽快从 `*` 收紧为具体域名列表。
- 历史上泄露过的旧 PAT 应在 GitHub → Settings → Developer settings 中 revoke。
