export type DiagnosticResult = {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  durationMs: number;
};

export type DiagnosticCheck = {
  name: string;
  run(): Promise<Omit<DiagnosticResult, 'name' | 'durationMs'>>;
};

export async function runDiagnostics(
  checks: readonly DiagnosticCheck[],
): Promise<DiagnosticResult[]> {
  return Promise.all(
    checks.map(async (check) => {
      const start = performance.now();
      try {
        const result = await check.run();
        return { name: check.name, ...result, durationMs: performance.now() - start };
      } catch (error) {
        return {
          name: check.name,
          status: 'fail' as const,
          message: error instanceof Error ? error.message : String(error),
          durationMs: performance.now() - start,
        };
      }
    }),
  );
}
