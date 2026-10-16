/** Vitest 2's JSON reporter omits onFinished's unhandled errors argument.
 * This trusted companion supplies completion/error evidence independently of test output.
 */
export default class VitestRuntimeReporter {
  onFinished(_files: unknown, errors: unknown): void {
    const count = Array.isArray(errors) ? errors.length : "unknown";
    process.stderr.write(`BFLOW_VITEST_RUNTIME_ERRORS=${count}\n`);
  }
}
