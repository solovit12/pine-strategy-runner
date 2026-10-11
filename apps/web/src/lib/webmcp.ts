import type { BacktestResponse } from '../../../../packages/shared/src/contracts';

interface ModelContextTool {
  name: string;
  title: string;
  description: string;
  inputSchema: object;
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute(input: unknown): unknown | Promise<unknown>;
}

interface ModelContext {
  registerTool(tool: ModelContextTool, options?: { signal?: AbortSignal }): void | Promise<void>;
}

declare global {
  interface Document { readonly modelContext?: ModelContext }
}

const emptyInputSchema = { type: 'object', properties: {}, additionalProperties: false };

export function registerBacktestWebTools(actions: {
  run(): Promise<BacktestResponse>;
  stop(): boolean;
  reportError(error: unknown): void;
}) {
  const context = document.modelContext;
  if (!context?.registerTool) return () => undefined;
  const lifecycle = new AbortController();
  const register = (tool: ModelContextTool) => {
    try {
      void Promise.resolve(context.registerTool(tool, { signal: lifecycle.signal })).catch(actions.reportError);
    } catch (error) {
      actions.reportError(error);
    }
  };

  register({
    name: 'run_current_pine_backtest',
    title: 'Run Pine backtest',
    description: 'Run the Pine source and settings currently visible in the editor, update the chart, metrics and trades, then return a compact result.',
    inputSchema: emptyInputSchema,
    annotations: { readOnlyHint: false, untrustedContentHint: true },
    async execute(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 0) throw new Error('This tool accepts an empty object.');
      const result = await actions.run();
      return {
        runId: result.runId,
        totalProfit: result.metrics.totalProfit,
        closedProfit: result.metrics.netProfit,
        openProfit: result.metrics.openProfit,
        trades: result.metrics.totalTrades,
        maxDrawdown: result.metrics.maxDrawdown,
        tradingViewComparison: result.comparison.status,
      };
    },
  });

  register({
    name: 'request_current_backtest_stop',
    title: 'Stop Pine backtest',
    description: 'Request cancellation of the backtest that is currently running in the visible page.',
    inputSchema: emptyInputSchema,
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 0) throw new Error('This tool accepts an empty object.');
      return { stopRequested: actions.stop() };
    },
  });

  return () => lifecycle.abort();
}
