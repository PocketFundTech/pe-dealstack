export type ToolEmitEvent =
  | { type: 'side_effect'; effect: { type: string; [key: string]: unknown } }
  | { type: 'update'; update: { field: string; value: unknown; [key: string]: unknown } }
  | { type: 'action'; action: { type: string; label: string; url: string; [key: string]: unknown } };

export type ToolEmit = (event: ToolEmitEvent) => void;
