/**
 * rw-bot-token — GitHub API 写转发（Cloudflare Worker）
 *
 * 前端项目（RemixWarp 编辑器「网络还原点」/ rwc 各界面）不再内嵌 GitHub PAT。
 * 所有 GitHub API 请求经本 Worker 转发：token 由服务端持有并注入，
 * 仅当目标仓库位于 ALLOWED_REPOS 白名单时才放行，
 * 写操作（POST/PATCH/PUT）仅限 Git Data 与 Contents 两类路径。
 *
 * 环境变量（wrangler.toml [vars] 或 Dashboard → Settings → Variables）：
 *   ALLOWED_REPOS   逗号分隔的仓库白名单，如 "remixwarp/rwc,RemixWarp-rw/rw-owr"
 *   ALLOWED_ORIGINS 逗号分隔的 CORS 来源白名单，"*" 表示放行所有来源
 * 密钥（不要写进本文件，也不要写进 wrangler.toml）：
 *   GH_TOKEN        执行 npx wrangler secret put GH_TOKEN 配置；
 *                   classic PAT 需 repo scope，fine-grained PAT 需对白名单
 *                   仓库拥有 Contents: Read and Write 权限。
 */

const GITHUB_API = 'https://api.github.com/repos';

// 允许执行写操作（POST/PATCH/PUT）的路径：Git Data + Contents
const WRITE_PATH_RE = /^\/(git\/(blobs|trees|commits|refs(\/.*)?)|contents(\/.*)?)$/;
const WRITE_METHODS = new Set(['POST', 'PATCH', 'PUT']);

function buildCors (env, request) {
    const allow = String(env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    let allowOrigin = '*';
    if (!allow.includes('*')) {
        if (!origin) {
            // 非浏览器请求没有 Origin 头：放行，但只回一个固定值
            allowOrigin = allow[0];
        } else if (allow.includes(origin)) {
            allowOrigin = origin;
        } else {
            return null; // 浏览器来源不在白名单：拒绝
        }
    }
    return {
        'Access-Control-Allow-Origin': allowOrigin,
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, PATCH, PUT, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Accept, X-Requested-With',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin'
    };
}

function json (status, data, cors) {
    const headers = Object.assign({'Content-Type': 'application/json; charset=utf-8'}, cors || {});
    return new Response(JSON.stringify(data), {status, headers});
}

function repoList (env) {
    return String(env.ALLOWED_REPOS || '').split(',').map(s => s.trim()).filter(Boolean);
}

export default {
    async fetch (request, env) {
        const cors = buildCors(env, request);
        if (!cors) return json(403, {error: 'origin not allowed'});

        if (request.method === 'OPTIONS') {
            return new Response(null, {status: 204, headers: cors});
        }

        const url = new URL(request.url);

        // 健康检查：部署后先 curl /health 确认变量是否生效（不含任何机密）
        if (url.pathname === '/' || url.pathname === '/health') {
            return json(200, {
                ok: true,
                service: 'rw-bot-token',
                tokenConfigured: Boolean(env.GH_TOKEN),
                allowedRepos: repoList(env)
            }, cors);
        }

        // 路由：/api/:owner/:repo/<GitHub 仓库级路径>
        const m = url.pathname.match(/^\/api\/([^/]+)\/([^/]+)(\/.*)?$/);
        if (!m) {
            return json(404, {
                error: 'not found',
                hint: '用法：/api/:owner/:repo/git/blobs 等仓库级 GitHub API 路径；GET /health 查看状态'
            }, cors);
        }

        const owner = m[1];
        const repoName = m[2];
        const rest = m[3] || '/';

        // 仓库白名单（大小写不敏感）
        const target = `${owner}/${repoName}`.toLowerCase();
        const allowed = repoList(env).map(s => s.toLowerCase());
        if (!allowed.includes(target)) {
            return json(403, {error: `仓库 ${owner}/${repoName} 不在 ALLOWED_REPOS 白名单中`}, cors);
        }

        const method = request.method.toUpperCase();

        if (method === 'DELETE' || method === 'TRACE' || method === 'CONNECT') {
            return json(403, {error: `${method} 已禁用`}, cors);
        }
        if (WRITE_METHODS.has(method) && !WRITE_PATH_RE.test(rest)) {
            return json(403, {
                error: `不允许对 ${rest} 执行 ${method}`,
                hint: '写操作仅限 /git/blobs、/git/trees、/git/commits、/git/refs、/contents'
            }, cors);
        }

        if (!env.GH_TOKEN) {
            return json(500, {error: 'GH_TOKEN 未配置：请执行 npx wrangler secret put GH_TOKEN'}, cors);
        }

        let body;
        if (method !== 'GET' && method !== 'HEAD') {
            body = await request.text();
        }

        let gh;
        try {
            gh = await fetch(`${GITHUB_API}/${owner}/${repoName}${rest}${url.search}`, {
                method,
                headers: {
                    'Authorization': `token ${env.GH_TOKEN}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'User-Agent': 'rw-bot-token',
                    'Content-Type': 'application/json'
                },
                body
            });
        } catch (e) {
            return json(502, {error: `upstream fetch failed: ${e.message}`}, cors);
        }

        const text = await gh.text();
        const out = new Response(text, {status: gh.status});
        for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
        if (!out.headers.get('Content-Type')) {
            out.headers.set('Content-Type', 'application/json; charset=utf-8');
        }
        return out;
    }
};
