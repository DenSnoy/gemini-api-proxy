export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    url.host = 'generativelanguage.googleapis.com';

    const headers = new Headers(request.headers);
    headers.set('Host', 'generativelanguage.googleapis.com');

    headers.delete('cf-connecting-ip');
    headers.delete('cf-ray');
    headers.delete('cf-visitor');

    const isWebSocket = request.headers.get('Upgrade')?.toLowerCase() === 'websocket';

    let response;

    if (isWebSocket) {
      response = await fetch(url.toString(), {
        method: request.method,
        headers: headers,
      });
    } else {
      const hasNoBody = request.method === 'GET' || request.method === 'HEAD';
      response = await fetch(url.toString(), {
        method: request.method,
        headers: headers,
        body: hasNoBody ? null : request.body,
      });
    }

    const responseHeaders = new Headers(response.headers);
    responseHeaders.set('Access-Control-Allow-Origin', '*');

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
      webSocket: response.webSocket,
    });
  }
}