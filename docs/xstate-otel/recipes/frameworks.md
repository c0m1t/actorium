# Frameworks

The library is framework-neutral: anything that can call `sendCommand` from a
request handler works. Two things are framework-specific: starting the SDK
before the server code loads, and keeping actors outside request handlers.

## Start the SDK first

Auto-instrumentation patches modules as they load. Start the SDK in a module
that loads before the server, for example with Node's `--import` flag:

```sh
node --import ./telemetry.js ./server.js
```

Configure service identity and the exporter through the usual `OTEL_*`
environment variables, such as `OTEL_SERVICE_NAME` and
`OTEL_EXPORTER_OTLP_ENDPOINT`.

## Keep actors in a registry

Create actors once, in a module outside route handlers, and look them up per
request. In development, hot reloading route modules must not create duplicate
actors. In a scaled deployment, route each workflow to the one process that
owns its actor.

## React Router

In framework mode, a route action runs inside the HTTP server span:

<<< @/snippets/react-router.ts

Use the same approach in other frameworks with Web `Request`/`Response`
handlers. For a handler that waits, see
[wait for a result](http-boundaries.md#wait-for-a-result).

## Node `http`

<<< @/snippets/node-http.ts
