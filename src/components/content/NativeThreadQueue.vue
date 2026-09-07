<template>
    <section v-if="state.mode === 'native' && state.queue.length > 0" class="native-queue" aria-label="原生排队消息">
      <h3>排队消息 · {{ state.queue.length }}</h3>
      <p v-if="state.error" class="native-controls-error" role="alert">{{ state.error }}</p>
      <ol>
        <li v-for="(submission, index) in state.queue.slice(0, visibleQueueCount)" :key="submission.id" :data-queue-id="submission.id">
          <template v-if="editingId === submission.id">
            <textarea v-model="editingText" rows="2" aria-label="编辑原生排队消息" />
            <div class="native-controls-actions"><button type="button" :disabled="unavailable" @click="saveQueuedEdit">保存编辑</button><button type="button" @click="editingId = ''">取消</button></div>
          </template>
          <template v-else>
            <p>{{ nativeSubmissionText(submission).slice(0, 240) || '非文本输入' }}</p>
            <p v-if="submission.input.some(item => item.type !== 'text')" class="native-controls-muted">包含 {{ submission.input.filter(item => item.type !== 'text').length }} 项附加输入，编辑时保留。</p>
            <div class="native-controls-actions">
              <button type="button" :disabled="unavailable || isRunning" @click="controller.changeQueue('start', submission.id)">开始此条</button>
              <button type="button" :disabled="unavailable" @click="editQueued(submission)">编辑</button>
              <button type="button" :disabled="unavailable || index === 0" @click="controller.changeQueue('up', submission.id)">上移</button>
              <button type="button" :disabled="unavailable || index === state.queue.length - 1" @click="controller.changeQueue('down', submission.id)">下移</button>
              <button type="button" :disabled="unavailable" @click="controller.changeQueue('delete', submission.id)">删除</button>
            </div>
          </template>
        </li>
      </ol>
      <button v-if="state.queue.length > visibleQueueCount" type="button" @click="visibleQueueCount += 20">显示更多排队消息</button>
    </section>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { createNativeThreadController } from '../../composables/desktop/nativeThreadController'
import { nativeSubmissionText, type NativeSubmission } from '../../nativeThreadControls'
const props = defineProps<{ controller: ReturnType<typeof createNativeThreadController>; isRunning: boolean }>()
const state = computed(() => props.controller.state)
const unavailable = computed(() => state.value.loading || state.value.busy)
const editingId = ref('')
const editingText = ref('')
const visibleQueueCount = ref(20)
watch(() => state.value.threadId, () => { editingId.value = ''; editingText.value = ''; visibleQueueCount.value = 20 })
function editQueued(submission: NativeSubmission) { editingId.value = submission.id; editingText.value = nativeSubmissionText(submission) }
async function saveQueuedEdit() {
  await props.controller.changeQueue('edit', editingId.value, editingText.value)
  if (!state.value.error) editingId.value = ''
}
</script>
