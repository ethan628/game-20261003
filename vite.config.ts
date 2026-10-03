import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 5173,
    host: true,
    open: false
  },
  plugins: [
    {
      name: 'overpass-proxy-middleware',
      configureServer(server) {
        server.middlewares.use('/api/overpass', (req, res) => {
          if (req.method === 'POST') {
            let body = '';
            req.on('data', (chunk) => {
              body += chunk;
            });
            req.on('end', async () => {
              const mirrors = [
                'https://lz4.overpass-api.de/api/interpreter',
                'https://z.overpass-api.de/api/interpreter',
                'https://overpass-api.de/api/interpreter',
                'https://overpass.kumi.systems/api/interpreter'
              ];

              for (const mirror of mirrors) {
                try {
                  const controller = new AbortController();
                  const timer = setTimeout(() => controller.abort(), 9000);
                  const fetchResp = await fetch(mirror, {
                    method: 'POST',
                    headers: {
                      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                      'User-Agent': 'GTA-OSM-Viewer/1.0 (Windows NT 10.0; Win64; x64)'
                    },
                    body: body,
                    signal: controller.signal
                  });
                  clearTimeout(timer);

                  if (fetchResp.ok) {
                    const text = await fetchResp.text();
                    res.setHeader('Content-Type', 'application/json');
                    res.end(text);
                    return;
                  }
                } catch (e) {
                  // 嘗試下一個鏡像站
                }
              }

              res.statusCode = 502;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: 'All Overpass mirrors failed or timed out' }));
            });
          } else {
            res.statusCode = 405;
            res.end();
          }
        });
      }
    }
  ],
  build: {
    target: 'esnext'
  }
});
