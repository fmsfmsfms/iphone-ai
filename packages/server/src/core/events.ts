// In-process event hub. Services publish ServerEvents; the WebSocket layer
// fans them out to connected UIs (respecting per-connection permissions).

import { EventEmitter } from 'node:events';

import type { ServerEvent } from '@iphone-ai/shared';

export type EventListener = (event: ServerEvent) => void;

export class EventHub {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(200);
  }

  publish(event: ServerEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(listener: EventListener): () => void {
    this.emitter.on('event', listener);
    return () => {
      this.emitter.off('event', listener);
    };
  }
}
