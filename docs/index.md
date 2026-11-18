---
layout: false
title: Actorium
search: false
---

<script setup>
import { onMounted } from 'vue';
import { withBase } from 'vitepress';

onMounted(() => window.location.replace(withBase('/xstate-otel/')));
</script>

<p>Continue to the <a :href="withBase('/xstate-otel/')">xstate-otel documentation</a>.</p>
