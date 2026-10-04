import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.NODE_ENV === 'production' ? '/game-20261003/' : '/',
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

        // 儲存建築人工校正檔端點 (F6 開發模式直接寫回磁碟)
        server.middlewares.use('/api/save-override', (req, res) => {
          if (req.method === 'POST') {
            let body = '';
            req.on('data', (chunk) => {
              body += chunk;
            });
            req.on('end', async () => {
              try {
                const fs = await import('fs');
                const path = await import('path');
                const targetPath = path.resolve(process.cwd(), 'public/data/overrides.json');
                fs.writeFileSync(targetPath, body, 'utf8');
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ success: true, message: 'Successfully written to disk' }));
              } catch (err: any) {
                res.statusCode = 500;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: err.message }));
              }
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
