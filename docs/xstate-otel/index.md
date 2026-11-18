---
layout: home
hero:
  name: xstate-otel
  text: OpenTelemetry tracing for long-lived XState actors
  tagline: One bounded trace per command, not one endless span per actor.
  actions:
    - theme: brand
      text: Get started
      link: /xstate-otel/guide/getting-started
    - theme: alt
      text: Introduction
      link: /xstate-otel/guide/introduction
features:
  - title: Commands become operations
    details: sendCommand starts an operation span that follows the deliveries, relays and Promise work the command causes, then ends.
  - title: Promise work becomes child spans
    details: tracing.fromPromise wraps finite Promise logic. It joins the creating operation automatically, with ordinary business input.
  - title: Business data stays clean
    details: No trace IDs, spans or contexts in machine context, events or inputs. Associations live in private side tables.
  - title: Your SDK, your exporter
    details: XState and @opentelemetry/api are the only peers. The application owns the SDK, sampling and export.
---
