const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = 8080;

const MIME_TYPES = {
    '.html': 'text/html',
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.wav': 'audio/wav',
    '.mp4': 'video/mp4',
    '.woff': 'application/font-woff',
    '.ttf': 'application/font-ttf',
    '.eot': 'application/vnd.ms-fontobject',
    '.otf': 'application/font-otf',
    '.wasm': 'application/wasm'
};

const server = http.createServer((req, res) => {
    console.log(`${req.method} ${req.url}`);

    // Strip query parameters
    const urlWithoutQuery = req.url.split('?')[0];
    
    // Decode URL to handle spaces and special characters
    const decodedUrl = decodeURIComponent(urlWithoutQuery);
    let filePath = path.join(__dirname, decodedUrl === '/' ? 'index.html' : decodedUrl);
    
    // Safety check: ensure file is within __dirname
    if (!filePath.startsWith(__dirname)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    const extname = path.extname(filePath);
    let contentType = MIME_TYPES[extname] || 'application/octet-stream';

    fs.readFile(filePath, (error, content) => {
        if (error) {
            if (error.code === 'ENOENT') {
                res.writeHead(404);
                res.end('404 Not Found');
            } else {
                res.writeHead(500);
                res.end('500 Internal Server Error: ' + error.code);
            }
        } else {
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content, 'utf-8');
        }
    });
});

server.listen(PORT, () => {
    console.log(`\n  🌟 LeadTube Hub running at http://localhost:${PORT}`);
    console.log(`  🚀 Everything is now unified and ready for action!\n`);
    
    // Start Backends
    const backends = [
        { name: 'Bulk Email', path: path.join(__dirname, 'Bulk Email', 'server.js'), port: 3000 }
    ];

    backends.forEach(service => {
        if (fs.existsSync(service.path)) {
            console.log(`  Starting ${service.name} backend on port ${service.port}...`);
            exec(`node "${service.path}"`, (err, stdout, stderr) => {
                if (err) {
                    console.log(`  [Info] ${service.name} backend issue: ${err.message.substring(0, 50)}...`);
                    return;
                }
                console.log(stdout);
            });
        } else {
            console.log(`  [Warning] ${service.name} backend not found at ${service.path}`);
        }
    });
});
