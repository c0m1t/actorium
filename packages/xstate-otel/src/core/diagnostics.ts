import type { LifecycleOptions, TelemetryDiagnostic } from './types.js';

/** Protects application callbacks and routes their failures. */
export class Diagnostics {
  private readonly options: Pick<LifecycleOptions, 'onTelemetryError'>;
  private readonly fallback: (diagnostic: TelemetryDiagnostic) => void;

  constructor(
    options: Pick<LifecycleOptions, 'onTelemetryError'>,
    fallback: (diagnostic: TelemetryDiagnostic) => void,
  ) {
    this.options = options;
    this.fallback = fallback;
  }

  protect<T>(phase: TelemetryDiagnostic['phase'], callback: () => T, fallback: T): T {
    try {
      return callback();
    } catch (error) {
      this.report({ phase, error });
      return fallback;
    }
  }

  report(diagnostic: TelemetryDiagnostic): void {
    try {
      if (this.options.onTelemetryError) {
        this.options.onTelemetryError(diagnostic);
      } else if (
        diagnostic.phase !== 'unassociatedRootError' &&
        diagnostic.phase !== 'associatedRootError'
      ) {
        this.fallback(diagnostic);
      }
    } catch {
      // Reporting is observational. XState owns the original actor error and
      // native uncaught reporting; telemetry callbacks must not replace either.
    }
  }
}
