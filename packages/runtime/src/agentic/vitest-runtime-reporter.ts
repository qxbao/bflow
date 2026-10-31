/** Vitest 2's JSON reporter omits onFinished's unhandled errors argument.
 * This trusted companion supplies completion/error evidence independently of test output.
 */
export default class VitestRuntimeReporter {
  private reported = false;
  private emit(errors: unknown): void {
    if (this.reported) return;
    this.reported = true;
    const count = Array.isArray(errors) ? errors.length : "unknown";
    process.stderr.write(`BFLOW_VITEST_RUNTIME_ERRORS=${count}\n`);
  }
  onFinished(_files: unknown, errors: unknown): void {
    this.emit(errors);
  }
  onTestRunEnd(_modules: unknown, unhandledErrors: unknown): void {
    this.emit(unhandledErrors);
  }
}
