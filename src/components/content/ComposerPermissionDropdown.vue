<template>
  <ComposerDropdown class="composer-permission-menu" :model-value="selected" :options="options" :placeholder="label" open-direction="up" :disabled="disabled"
    @opened="emit('opened')" @update:model-value="select">
    <template #prefix><svg class="composer-permission-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M8 13V5a1.5 1.5 0 0 1 3 0v6-8a1.5 1.5 0 0 1 3 0v8-6a1.5 1.5 0 0 1 3 0v7-3a1.5 1.5 0 0 1 3 0v6c0 5-3 7-7 7-3 0-5-2-7-5l-3-4c-1-2 1-3 2-2l3 3" /></svg></template>
    <template #header><div class="composer-permission-heading">操作权限</div><p v-if="error" class="composer-permission-error" role="alert">{{ error }}</p><p v-else-if="loading" class="composer-permission-description">正在读取会话权限…</p><p v-else-if="native && !options.length" class="composer-permission-description">没有可选权限配置</p></template>
    <template #option="{ option }"><span class="composer-permission-option-copy" :class="{ 'is-danger': isFullAccess(option.value) }"><span>{{ option.label }}</span><small>{{ description(option.value) }}</small></span><span class="composer-permission-check" aria-hidden="true">{{ option.value === selected ? '✓' : '' }}</span></template>
  </ComposerDropdown>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import ComposerDropdown from './ComposerDropdown.vue'
import type { NativePermissionProfile } from '../../nativeThreadControls'
import type { CodexPermissionMode } from '../../types/codex'
const props = defineProps<{ native?: boolean; nativeProfile?: string | null; profiles: NativePermissionProfile[]; modelValue: CodexPermissionMode; disabled?: boolean; loading?: boolean; error?: string }>()
const emit = defineEmits<{ opened: []; 'update:modelValue': [value: string]; 'select-native': [value: string] }>()
const isFullAccess = (id: string) => /(^|:)danger-full-access$|^full-access$/.test(id)
function display(id: string) {
  if (isFullAccess(id)) return '完全访问权限'
  if (id === 'request-approval') return '请求批准'
  if (id === 'auto-approve') return '自动批准'
  if (id === ':workspace' || id === 'workspace') return '工作区权限'
  if (id === ':workspace-write' || id === 'workspace-write') return '工作区写入'
  if (id === ':read-only' || id === 'read-only') return '只读'
  return id.replace(/^:/, '') || '会话权限'
}
const selected = computed(() => props.native ? props.nativeProfile || '' : props.modelValue)
const label = computed(() => display(selected.value))
const options = computed(() => props.native ? props.profiles.filter(p => p.allowed).map(p => ({value:p.id,label:display(p.id)})) : ['request-approval','auto-approve','full-access'].map(id => ({value:id,label:display(id)})))
function description(id: string) {
  if (props.native) return props.profiles.find(p => p.id === id)?.description || '仅用于本会话后续回合'
  return id === 'request-approval' ? '需要时请求批准' : id === 'auto-approve' ? '自动批准允许范围内的操作' : '允许不受沙箱限制的操作'
}
function select(value: string) { if (!props.disabled && options.value.some(o => o.value === value)) { if (props.native) emit('select-native',value); else emit('update:modelValue',value) } }
</script>
<style scoped>
.composer-permission-icon { width:16px; height:16px; flex-shrink:0; }
.composer-permission-heading { padding:8px 10px; color:var(--mac-muted); font-size:13px; }
.composer-permission-option-copy { display:flex; flex-direction:column; gap:2px; flex:1; min-width:0; }
.composer-permission-option-copy > span { font-size:14px; font-weight:500; }
.composer-permission-option-copy small { font-size:12px; line-height:1.4; color:var(--mac-muted); white-space:normal; }
.composer-permission-option-copy.is-danger, .composer-permission-option-copy.is-danger small { color:#ed6518; }
.composer-permission-check { flex-shrink:0; font-size:18px; padding-left:12px; }
.composer-permission-error { color:#d95353; font-size:12px; max-width:300px; padding:8px 10px; }
.composer-permission-description { color:var(--mac-muted); padding:8px 10px; font-size:12px; }
</style>
