<script setup lang="ts">
import { data as rows } from './attributes.data.ts';
</script>

# Attributes

Every attribute, span-event name and default span name the library emits
starts with the attribute namespace, `actorium.xstate` by default. Set
`attributeNamespace` to change it.

## Names

This table is generated from the library's name table. Names are shown under
the default namespace, with their property in `keys = getAttributeKeys()`.

<table>
  <thead>
    <tr><th>Name and key</th><th>Where and meaning</th></tr>
  </thead>
  <tbody>
    <tr v-for="row in rows" :key="row.key">
      <td><code>actorium.xstate.{{ row.name }}</code><br /><code>keys.{{ row.key }}</code></td>
      <td><strong>{{ row.where }}:</strong> <span v-html="row.meaning"></span></td>
    </tr>
  </tbody>
</table>

Two options replace a full key instead of using the namespace:
`actorIdAttribute` and `detailsUnavailableAttribute`. Either can be `false` to
omit the attribute.

Standard OpenTelemetry names are never prefixed: failures use the `exception`
event with `exception.type`, `exception.message` and `exception.stacktrace`.
Attributes your application supplies keep their names. XState's own event
types, such as `xstate.init`, appear unchanged as values.

## In queries and tests

`getAttributeKeys(namespace?)` returns the complete map for a namespace, so
dashboards and tests never spell names by hand:

<<< @/snippets/attribute-keys.ts
