---
aside: false
---

<script setup>
import { withBase } from 'vitepress';
import ShowcaseViewer from '../../.vitepress/components/ShowcaseViewer.vue';
import { data as showcase } from '../../.vitepress/components/showcase.data';
</script>

# Showcase

<a v-if="showcase.sourceUrl" :href="showcase.sourceUrl"><code>packages/xstate-otel/examples/showcase</code></a>
<code v-else>packages/xstate-otel/examples/showcase</code>
is a small order desk you can run locally. A long-lived `orders` actor spawns
one `order` actor per order; each order reserves stock and charges a payment in
parallel, then notifies the customer. The services are in-process fakes, so
the app needs no network or database.

A page lists the scenarios. Each run is one HTTP request, and the page draws
every trace the request produced, including traces linked to it, as a waterfall.
Select a span to see its attributes, events and links; a link jumps to the
span at its other end. Its README has the commands to start it and to send the
spans to Jaeger.

## Explore the traces

The viewer is embedded directly in this page and contains recordings of all nine
scenarios, regenerated from real HTTP runs whenever the docs are built or started.
Select a scenario, inspect a span, follow its links or turn on **Show microsteps**.
Selecting a scenario displays its recording; it does not execute a new request.

Links in the scenario descriptions open the relevant guides and references.

Expand **Code for this scenario** below the traces to see the selected scenario's
source. The **Machine** and **Tracing setup** tabs show the shared actor definitions,
tracing options and host SDK setup. Snippets are read from the example's source
files when the viewer is generated.

<p><a :href="withBase('/xstate-otel/showcase/index.html')" target="_blank" rel="noopener">Open the viewer in a full window ↗</a></p>

<ShowcaseViewer />

The default runtime sets `recordMicrosteps`, so the operation spans show each
event an actor processed, including relays between `orders` and `order`. The
page hides them until you turn on **Show microsteps**.

## Tests

`tests/showcase.test.ts` starts the server, runs every scenario over HTTP and
compares an outline of its span tree. The server calls `waitForBookkeeping()` before it
ends the request span, so every operation has ended when the response
arrives. It is a working example of [testing with `waitForBookkeeping()`](../recipes/testing.md).
