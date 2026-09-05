const http = require('node:http')
http.createServer((request, response) => {
  response.setHeader('Content-Type', 'application/json')
  if (request.url.includes('/models')) {
    const model = request.url.includes('/beta/') ? 'gpt-5.6-luna' : 'gpt-6-astra'
    response.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model' }] }))
    return
  }
  response.statusCode = 401
  response.end(JSON.stringify({ error: { message: 'PHASE1_INVALID_AUTH: supplied test credential has expired', type: 'invalid_request_error', code: 'invalid_api_key' } }))
}).listen(8099, '127.0.0.1')
