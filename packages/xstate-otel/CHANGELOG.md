# Changelog

## [0.2.0](https://github.com/c0m1t/actorium/compare/xstate-otel-v0.1.0...xstate-otel-v0.2.0) (2026-11-21)


### ⚠ BREAKING CHANGES

* public API, telemetry and name-map renames:
    - `CommandOutcome` → `OperationOutcome`
    - `CommandResult` → `OperationResult`
    - `CommandTrace` → `OperationTrace`
    - `settle()` → `waitForBookkeeping()`
    - `onTelemetryError` → `onDiagnostic`
    - `attributeNamespace` → `telemetryNamespace`
    - `DEFAULT_ATTRIBUTE_NAMESPACE` → `DEFAULT_TELEMETRY_NAMESPACE`
    - `getAttributeKeys()` → `getTelemetryNames()`
    - `AttributeKeys` → `TelemetryNames`
    - `scheduledWorkPolicy` → `timerPolicy`
    - `ScheduledWorkPolicy` → `TimerPolicy`
    - `ScheduledWorkPolicyArgs` → `TimerPolicyArgs`
    - diagnostic phase `scheduledWorkPolicy` → `timerPolicy`
    - `TelemetryNames` property `commandEvent` → `operationEventType`
    - `TelemetryNames` property `scheduledAction` → `timerAction`
    - `TelemetryNames` property `scheduledDelayMs` → `timerDelayMs`
    - `TelemetryNames` property `scheduledOriginOperationId` → `timerOriginOperationId`
    - `TelemetryNames` property `scheduledSpan` → `timerOperationSpan`
    - attribute `command.event` → `operation.event_type`
    - attribute `scheduled.action` → `timer.action`
    - attribute `scheduled.delay_ms` → `timer.delay_ms`
    - attribute `scheduled.origin_operation_id` → `timer.origin_operation_id`
    - default timer span name `scheduled` → `timer_operation`
* `CommandOutcome` drops `dropped`; the name-map properties `operationDroppedDeliveryCount` and `deliveryDroppedEvent` are replaced.

### refactor

* align public and internal terminology ([#16](https://github.com/c0m1t/actorium/issues/16)) ([315e8f1](https://github.com/c0m1t/actorium/commit/315e8f14d2b260e3e58561b41546277e3600169c))


### Bug Fixes

* match nested same-event commands to the innermost send ([#9](https://github.com/c0m1t/actorium/issues/9)) ([98eb630](https://github.com/c0m1t/actorium/commit/98eb63045186372f560ef42228b96a5616c3ed7e))
* send commands natively and split the dropped outcome ([#8](https://github.com/c0m1t/actorium/issues/8)) ([725c52c](https://github.com/c0m1t/actorium/commit/725c52cdedf95b60437513619e528f923b944bd4))

## 0.1.0 (2026-11-18)


### Features

* initial release ([7244794](https://github.com/c0m1t/actorium/commit/72447942af043da49f1aa687e23d6e17f6fe18c0))
