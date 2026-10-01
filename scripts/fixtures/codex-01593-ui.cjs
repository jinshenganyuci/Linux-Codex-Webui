// Browser-only fixtures: these IDs are never created in the real app-server.
const THREAD_A = '01593000-0000-4000-8000-000000000001'
const THREAD_B = '01593000-0000-4000-8000-000000000002'
const DRAFT_KEY = 'codex-web-local.pending-input-drafts.v1'
const RECEIVED_AT = '2026-10-01T08:00:00.000Z'
const REQUEST_IDS = { blocking: 159301, optional: 159302, secret: 159303, otherThread: 159304 }

function question(id, threadId, header, isBlocking, isSecret = false) {
  const turnId = `fixture-turn-${threadId}`
  const itemId = `fixture-question-${id}`
  return {
    id, generation: 1593, method: 'item/tool/requestUserInput',
    threadId, turnId, itemId, receivedAtIso: RECEIVED_AT,
    params: {
      threadId, turnId, itemId, isBlocking,
      questions: [{ id: 'answer', header, question: `${header}：填写验收答案。`, isOther: true, isSecret, options: [] }],
    },
  }
}

function createRequests() {
  return [
    question(REQUEST_IDS.optional, THREAD_A, '可稍后回答的问题', false),
    question(REQUEST_IDS.blocking, THREAD_A, '需要先回答的问题', true),
    question(REQUEST_IDS.secret, THREAD_A, '私密输入验证', false, true),
    question(REQUEST_IDS.otherThread, THREAD_B, '另一会话的问题', false),
  ]
}

function thread(id) {
  const label = id === THREAD_A ? '多问题草稿验收' : '跨会话草稿验收'
  const turnId = `fixture-turn-${id}`
  const turns = [{ id: turnId, status: 'inProgress', error: null, items: [
    { id: `user-${id}`, type: 'userMessage', content: [{ type: 'text', text: label, text_elements: [] }] },
    { id: `assistant-${id}`, type: 'agentMessage', text: `CODEX_01593_UI_READY ${label}` },
  ] }]
  return {
    id, name: label, preview: label, cwd: '/tmp/codex-01593-ui-fixture', path: null,
    model: 'gpt-6-astra', modelProvider: 'openai', reasoningEffort: 'high',
    createdAt: 1790834400, updatedAt: 1790834400, cliVersion: '0.159.3',
    source: 'appServer', gitInfo: null, historyMode: 'paginated',
    status: { type: 'active', activeFlags: [] }, turns,
  }
}

function diagnostics(memoryStatus = 'available') {
  return {
    webui: { version: '0.0.0-ui-fixture', commit: '01593abc1234567890', dirty: false },
    codex: {
      version: '0.154.0', startedAt: RECEIVED_AT, home: '/fixture/codex-home',
      command: '/fixture/pinned/codex', catalogStatus: 'ready', generation: 1593, running: true,
    },
    systemCli: { status: 'available', version: '0.159.3', command: '/fixture/system/codex', checkedAt: RECEIVED_AT },
    explicitRuntime: true,
    memory: {
      status: memoryStatus, reason: memoryStatus === 'available' ? 'confirmed' : memoryStatus === 'unsupported' ? 'unsupported' : 'unavailable',
      v2Ready: memoryStatus === 'available' ? true : null,
      v2ConsolidatedThreads: memoryStatus === 'available' ? 7 : null, checkedAt: RECEIVED_AT,
    },
    temporaryFeatures: { status: 'unknown', verifiedKeys: [] },
  }
}

module.exports = { THREAD_A, THREAD_B, DRAFT_KEY, REQUEST_IDS, createRequests, diagnostics, thread }
