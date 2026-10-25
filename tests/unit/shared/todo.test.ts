import { describe, expect, it } from 'vitest';
import { NotImplementedError, notImplemented } from '../../../src/shared/todo.js';

describe('shared/todo', () => {
  it('notImplemented бросает NotImplementedError с этапом и функцией в сообщении', () => {
    const call = (): never => notImplemented('этап 2', 'whatsapp/connection.startWhatsApp');

    expect(call).toThrow(NotImplementedError);
    expect(call).toThrow('этап 2');
    expect(call).toThrow('whatsapp/connection.startWhatsApp');
  });

  it('NotImplementedError остаётся обычной ошибкой и хранит этап и функцию', () => {
    const error = new NotImplementedError('этап 3', 'llm/anthropic.createAnthropicLlm');

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('NotImplementedError');
    expect(error.stage).toBe('этап 3');
    expect(error.feature).toBe('llm/anthropic.createAnthropicLlm');
  });
});
