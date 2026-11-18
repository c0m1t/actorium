# xstate-otel showcase

An order desk traced with [`@actorium/xstate-otel`](../..). A
long-lived `orders` actor spawns one `order` actor per order; each order
reserves stock, charges a payment and notifies the customer through in-process
fakes. A page lists the scenarios and draws the traces each one produced.

Expand **Code for this scenario** below the traces to inspect its source, the
shared machine and the tracing/SDK setup. The live app reads and highlights these
files at startup; the website embeds them during its build.
File labels link to the source and line at that checked-out Git commit. Without
Git metadata, or for locally edited files, the viewer keeps plain file labels.

```sh
pnpm install
pnpm --filter @actorium/xstate-otel-showcase start   # http://localhost:3000
```

`start` builds the library, then runs `src/main.ts` with Node's type stripping; the app itself has no build step. Set `PORT` to change
the port.

The [showcase guide](https://c0m1t.github.io/actorium/xstate-otel/guide/showcase) explains
what each scenario demonstrates and embeds an interactive viewer of recorded traces.

## Record for the website

From the workspace root, `pnpm run docs:build` runs all nine scenarios through the
same HTTP server and embeds their responses in the shared page. The generated
viewer works on static hosting without a backend. It is also regenerated before
`pnpm run docs:dev`; restart that command after changing the showcase.

To write a standalone viewer without building the docs:

```sh
pnpm --filter @actorium/xstate-otel-showcase run record ./showcase.html
```

Relative output paths use the directory where you invoked pnpm, even when its
filter runs the recorder from another package. Absolute paths work too. The docs
pass their output path as an absolute path, independently of the example's location.

Recording uses the real timers and never exports spans to an external collector.
Selecting a scenario in the recorded viewer displays its saved response. Use
`start` to run new scenarios interactively.

## Code

| File                     | Contains                                                           |
| ------------------------ | ------------------------------------------------------------------ |
| `src/telemetry.ts`       | The host-owned SDK: provider, context manager, optional OTLP       |
| `src/showcase.ts`        | The two tracing runtimes and their options                         |
| `src/desk.ts`            | The `orders` and `order` machines and the commands that enter them |
| `src/scenarios.ts`       | One function per scenario                                          |
| `src/server.ts`          | `node:http` routes; each run is one SERVER span                    |
| `src/recording.ts`       | Runs the HTTP scenarios and embeds their responses in the page     |
| `src/source-code.ts`     | Extracts and highlights the real sources for the code tabs         |
| `tests/showcase.test.ts` | Runs every scenario over HTTP and asserts its span tree            |

The SERVER and CLIENT spans stand in for HTTP instrumentation, which a real
host installs with its SDK.

## Jaeger

```sh
docker compose up -d
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 pnpm --filter @actorium/xstate-otel-showcase start
```

Spans still appear on the page and are also exported to Jaeger at
<http://localhost:16686> under the `xstate-otel-showcase` service.
