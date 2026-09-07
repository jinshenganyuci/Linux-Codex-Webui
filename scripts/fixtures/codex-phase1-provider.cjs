const http = require('node:http')
const { appendFileSync } = require('node:fs')
http.createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json')
  if (request.url.includes('/models')) {
    const model = request.url.includes('/beta/') ? 'gpt-5.6-luna' : 'gpt-6-astra'
    response.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model' }] }))
    return
  }
  let body = ''
  request.on('data', chunk => { body += chunk })
  request.on('end', () => {
    try { const payload = JSON.parse(body); appendFileSync('/tmp/codex-provider-tiers.jsonl', JSON.stringify({ model: payload.model, serviceTier: payload.service_tier ?? null }) + '\n') } catch {}
    response.statusCode = 401
    response.end(JSON.stringify({ error: { message: 'PHASE1_INVALID_AUTH: supplied test credential has expired', type: 'invalid_request_error', code: 'invalid_api_key' } }))
  })
}).listen(8099, '127.0.0.1')
