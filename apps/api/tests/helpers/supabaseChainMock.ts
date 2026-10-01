/**
 * Generic chainable Supabase query-builder mock for route tests.
 *
 * Every `supabase.from(table)` call returns a builder that records the
 * action (select / insert / update / delete / upsert), its payload and every
 * filter, then resolves through a single `resolver(op)` callback when the
 * chain is awaited or ends in `.single()` / `.maybeSingle()`. Tests describe
 * the database in one function instead of hand-building a nested object per
 * call shape, and can assert on `calls` afterwards.
 */

export type ChainAction = 'select' | 'insert' | 'update' | 'delete' | 'upsert';

export interface ChainOp {
  table: string;
  action: ChainAction;
  payload?: unknown;
  columns?: string;
  selectOptions?: Record<string, unknown>;
  filters: Array<{ method: string; args: unknown[] }>;
  terminal: 'single' | 'maybeSingle' | 'then';
}

export interface ChainResult {
  data?: unknown;
  error?: unknown;
  count?: number | null;
}

export type ChainResolver = (op: ChainOp) => ChainResult | undefined;

const FILTER_METHODS = [
  'eq', 'neq', 'is', 'in', 'ilike', 'like', 'contains', 'order', 'limit',
  'gte', 'lte', 'gt', 'lt', 'not', 'or', 'match', 'filter', 'range',
];

/** Find the value passed to `.eq(column, value)` (or another filter) on an op. */
export function filterValue(op: ChainOp, column: string, method = 'eq'): unknown {
  const f = op.filters.find((x) => x.method === method && x.args[0] === column);
  return f ? f.args[1] : undefined;
}

export function makeSupabaseChainMock(resolver: ChainResolver) {
  const calls: ChainOp[] = [];

  const from = (table: string) => {
    const op: Omit<ChainOp, 'terminal'> = { table, action: 'select', filters: [] };
    let actionSet = false;

    const finish = (terminal: ChainOp['terminal']): Promise<ChainResult> => {
      const full: ChainOp = { ...op, terminal };
      calls.push(full);
      const result = resolver(full) ?? {};
      return Promise.resolve({
        data: result.data ?? null,
        error: result.error ?? null,
        count: result.count ?? null,
      });
    };

    const builder: Record<string, unknown> = {};
    const setAction = (action: ChainAction, payload?: unknown) => {
      if (!actionSet) {
        op.action = action;
        op.payload = payload;
        actionSet = true;
      }
      return builder;
    };
    builder.select = (columns?: string, options?: Record<string, unknown>) => {
      // .insert(...).select() keeps the insert action; columns are informational.
      if (!actionSet) {
        op.columns = columns;
        op.selectOptions = options;
      }
      return builder;
    };
    builder.insert = (payload: unknown) => setAction('insert', payload);
    builder.update = (payload: unknown) => setAction('update', payload);
    builder.upsert = (payload: unknown) => setAction('upsert', payload);
    builder.delete = () => setAction('delete');
    for (const m of FILTER_METHODS) {
      builder[m] = (...args: unknown[]) => {
        op.filters.push({ method: m, args });
        return builder;
      };
    }
    builder.single = () => finish('single');
    builder.maybeSingle = () => finish('maybeSingle');
    builder.then = (onFulfilled: (v: ChainResult) => unknown, onRejected?: (e: unknown) => unknown) =>
      finish('then').then(onFulfilled, onRejected);
    return builder;
  };

  return { from, calls };
}
