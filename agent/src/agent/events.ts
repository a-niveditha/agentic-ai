export type StreamEventType = 'start' | 'token' | 'tool_start' | 'tool_end' | 'citation' | 'error' | 'done';

export interface StreamEvent {
  type: StreamEventType;
  payload: any;
  timestamp: number;
}

export function createEvent(type: StreamEventType, payload: unknown): StreamEvent {
  return { type, payload, timestamp: Date.now() };
}
