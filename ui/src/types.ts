export type QueueStats = {
  ready: number;
  inFlight: number;
  dlq: number;
};

export type QueueRow = { name: string } & QueueStats;

export type DlqTask = {
  id: string;
  type: 'llm' | 'js' | 'http';
  failureKind: string | null;
  lastError: string | null;
  failedAt: string | null;
};

export type DlqPage = {
  tasks: DlqTask[];
  nextCursor: string | null;
};
