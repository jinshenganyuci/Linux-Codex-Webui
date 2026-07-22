<template>
  <header class="content-header">
    <div class="content-leading" :class="{ 'is-accent': accent }">
      <slot name="leading" />
    </div>
    <h1 class="content-title" :class="{ 'is-accent': accent }" :title="title">{{ title }}</h1>
    <div class="content-actions">
      <slot name="actions" />
    </div>
  </header>
</template>

<script setup lang="ts">
defineProps<{
  title: string
  accent?: boolean
}>()
</script>

<style scoped>
@reference "tailwindcss";

.content-header {
  @apply relative w-full min-w-0 flex items-center gap-2 sm:gap-3 px-3 sm:px-4 bg-white;
  z-index: var(--ui-z-sticky);
  min-height: 3.25rem;
}

.content-title {
  @apply m-0 min-w-0 max-w-[min(72ch,100%)] flex-1 truncate text-sm font-semibold leading-6 text-slate-900;
  letter-spacing: -0.01em;
}

.content-title.is-accent {
  @apply text-lg font-semibold leading-7 text-zinc-950 sm:text-[1.25rem];
  letter-spacing: -0.018em;
}

.content-actions {
  @apply ml-auto flex shrink-0 items-center justify-end gap-2;
}

.content-leading {
  @apply flex shrink-0 items-center gap-1;
}

.content-leading.is-accent {
  @apply gap-2;
}

:global(:root.dark) .content-title.is-accent {
  @apply text-zinc-100;
}

@media (min-width: 640px) {
  .content-header {
    min-height: 3.5rem;
  }
}

@media (max-width: 639px) {
  .content-actions {
    min-width: 0;
    flex-shrink: 1;
  }
}
</style>
