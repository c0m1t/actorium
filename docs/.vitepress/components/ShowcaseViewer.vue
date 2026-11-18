<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue';
import { withBase } from 'vitepress';
import { mountShowcase } from '@actorium/xstate-otel-showcase/viewer';
import '@actorium/xstate-otel-showcase/viewer.css';
import { data } from './showcase.data';

const viewer = ref();
const message = ref(data.recordingUrl
  ? 'Loading recorded scenarios…'
  : 'Recordings are not generated yet. Run pnpm run docs:showcase before starting the local preview.');
let controller;
let dispose;

onMounted(async () => {
  if (!data.recordingUrl) return;
  controller = new AbortController();
  try {
    const response = await fetch(withBase(data.recordingUrl), { signal: controller.signal });
    if (!response.ok) throw new Error(`Recording request failed: ${response.status}`);
    const recording = await response.json();
    if (controller.signal.aborted) return;
    dispose = mountShowcase(viewer.value, {
      scenarios: recording.recordings,
      sources: recording.sources,
      docsBase: new URL(withBase('/xstate-otel/'), location.href),
      runScenario: (scenario) => scenario.run,
      autoRun: true,
    });
    message.value = '';
  } catch {
    if (!controller.signal.aborted) message.value = 'Unable to load the recordings. Please reload the page.';
  }
});
onBeforeUnmount(() => {
  controller?.abort();
  dispose?.();
});
</script>

<template>
  <p v-if="message" role="status">{{ message }}</p>
  <div
    ref="viewer"
    v-show="!message"
    class="showcase-viewer"
    role="region"
    aria-label="Recorded showcase scenarios"
  ></div>
</template>

<style scoped>
.showcase-viewer {
  font-family: var(--vp-font-family-base);
  border: 1px solid var(--vp-c-divider);
  border-radius: 8px;
}
</style>
