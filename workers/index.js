/**
 * Cloudflare Workers - NovelAI 极速分流中转代理脚本
 * 
 * 作用：
 * 1. 智能分流：将账户/余额等请求（/user/*）转发至 api.novelai.net，将生图请求（/ai/*）转发至 image.novelai.net。
 * 2. 绕过网络限制：部署在 Cloudflare Anycast 边缘网络，配合自定义域名可在中国大陆环境下秒级直连。
 * 3. 完整性：支持 POST/GET/OPTIONS 等所有 HTTP 方法，完美传递 Bearer API Key 以及二进制图片流响应。
 */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. 智能分流判定
    // /user/ 开头的接口（例如 /user/data）属于官方 api 账号服务器，其余（例如 /ai/generate-image）属于官方生图服务器
    let targetHost = 'image.novelai.net';
    if (url.pathname.startsWith('/user/')) {
      targetHost = 'api.novelai.net';
    }

    // 2. 构建新的请求目标 URL
    const targetUrl = new URL(request.url);
    targetUrl.hostname = targetHost;
    targetUrl.protocol = 'https:';
    targetUrl.port = '';

    // 3. 深度克隆并重置头部，保留授权 Bearer Token 各种必备头
    const newHeaders = new Headers(request.headers);
    newHeaders.set('host', targetHost);

    // 4. 构建转发的请求对象
    const newRequest = new Request(targetUrl, {
      method: request.method,
      headers: newHeaders,
      body: request.method === 'GET' || request.method === 'HEAD' ? null : request.body,
      redirect: 'follow'
    });

    try {
      // 5. 向官方服务器发起中转 fetch 请求
      const response = await fetch(newRequest);

      // 6. 完整返回官方响应（包含状态码、头信息及图片二进制 body）
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    } catch (err) {
      console.error('NovelAI 转发异常:', err);
      return new Response(`NovelAI Proxy Error: ${err.message || err}`, {
        status: 502,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8'
        }
      });
    }
  }
};
