import { describe, expect, it } from 'vitest';
import { createWhatsAppStateTracker } from '../../../src/pipeline/whatsapp-state.js';

describe('состояние сокета WhatsApp для консоли', () => {
  it('до первого события connecting с момента создания', () => {
    const tracker = createWhatsAppStateTracker({ now: () => 1000 });

    expect(tracker.snapshot()).toEqual({ state: 'connecting', sinceMs: 1000 });
  });

  it('смена состояния запоминает время; то же состояние время не сдвигает', () => {
    let now = 1000;
    const tracker = createWhatsAppStateTracker({ now: () => now });

    now = 2000;
    tracker.update('open');
    now = 3000;
    tracker.update('open');
    const opened = tracker.snapshot();
    now = 4000;
    tracker.update('closed');

    expect(opened).toEqual({ state: 'open', sinceMs: 2000 });
    expect(tracker.snapshot()).toEqual({ state: 'closed', sinceMs: 4000 });
  });
});
