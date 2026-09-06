import http from 'node:http';
import { gunzipSync } from 'node:zlib';

// Run with Node to count HTTP requests independently of Deno's receiver.
http
  .createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const body = JSON.parse(
      request.headers['content-encoding'] === 'gzip' ? gunzipSync(bytes) : bytes,
    );
    console.log(JSON.stringify(body.batch.map(({ event, messageId }) => ({ event, messageId }))));
    const upstream = http.request(
      {
        hostname: '127.0.0.1',
        port: 18081,
        path: request.url,
        method: request.method,
        headers: request.headers,
      },
      (result) => {
        response.writeHead(result.statusCode, result.headers);
        result.pipe(response);
      },
    );
    upstream.on('error', (error) => {
      console.error(error.message);
      response.destroy();
    });
    upstream.end(bytes);
  })
  .listen(18080, '127.0.0.1', () => console.log('Assessment proxy listening on 127.0.0.1:18080'));
