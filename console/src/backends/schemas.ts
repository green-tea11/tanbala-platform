import { z } from 'zod';

// Схемы ответов почты и бота. Строго — там, где консоль сама считает (расход, связи чат↔компания, письма,
// передачи, режим); остальное — объект или список с любыми полями (данные уже скопированы в пределах safe-json).

const MAX_COUNT = Number.MAX_SAFE_INTEGER;

export const countSchema = z.number().int().nonnegative().max(MAX_COUNT);
export const idSchema = z.number().int().positive().max(MAX_COUNT);
const daySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const priceSchema = z.number().nonnegative().max(10_000);
const moneySchema = z.number().nonnegative().max(1_000_000);
/** Время ISO 8601 (UTC или со сдвигом), как отдают оба приложения. */
export const isoTimeSchema = z
  .string()
  .max(40)
  .refine((value) => !Number.isNaN(Date.parse(value)), { message: 'не время ISO 8601' });
const nullableTime = isoTimeSchema.nullable();

export const anyObjectSchema = z.looseObject({});

/** Список с листанием: {items, total, page, pages, pageSize} плюс любые поля (facets, filters…). */
export const listSchema = z.looseObject({
  items: z.array(anyObjectSchema),
  total: countSchema,
  page: countSchema,
  pages: countSchema,
  pageSize: countSchema,
});

// Почта.

export const leadsSummarySchema = z.looseObject({
  testMode: z.looseObject({ testAddress: z.string().max(254).nullable() }),
  // dailyUsd null — бюджет не настроен (контракт: «Реализация почты»).
  budget: z.looseObject({
    dailyUsd: moneySchema.nullable(),
    spentTodayUsd: moneySchema,
    over: z.boolean(),
  }),
});

const tokenCounts = {
  calls: countSchema,
  input: countSchema,
  output: countSchema,
  cacheRead: countSchema,
  cacheWrite: countSchema,
};

export const pricesSchema = z.record(
  z.string().max(100),
  z.looseObject({
    input: priceSchema,
    output: priceSchema,
    cacheRead: priceSchema,
    cacheWrite: priceSchema,
  }),
);

export const leadsSpendSchema = z.looseObject({
  rows: z
    .array(z.looseObject({ day: daySchema, model: z.string().max(100), ...tokenCounts }))
    .max(20_000),
  prices: pricesSchema,
  pricesAsOf: z.string().max(20).nullable().optional(),
});

export const digestSchema = z.looseObject({
  items: z.array(
    z.looseObject({
      id: idSchema,
      name: z.string().max(500).nullable(),
      firstLetterAt: nullableTime,
    }),
  ),
});

export const activeRunSchema = anyObjectSchema.nullable();

// Бот.

export const waStatusSchema = z.looseObject({
  whatsapp: z.looseObject({ enabled: z.boolean(), state: z.string().max(20) }),
  testMode: z.boolean(),
  allowlistSize: countSchema.optional(),
  apiCalls: z.looseObject({ today: countSchema, dailyLimit: countSchema }),
});

export const waAttentionSchema = z.looseObject({
  handoffs: z.array(z.looseObject({ id: idSchema, chatId: idSchema })),
  hot: z.array(anyObjectSchema),
  waiting: z.array(anyObjectSchema),
});

export const waSpendSchema = z.looseObject({
  rows: z
    .array(
      z.looseObject({
        day: daySchema,
        provider: z.string().max(40),
        model: z.string().max(100),
        ...tokenCounts,
      }),
    )
    .max(20_000),
});

export const companyLinksSchema = z.looseObject({
  items: z
    .array(
      z.looseObject({
        chatId: idSchema,
        companyId: idSchema,
        name: z.string().max(300).nullable(),
        firstClientMessageAt: nullableTime,
      }),
    )
    .max(1000),
});

const linkedCompany = z.looseObject({ id: idSchema }).nullable().optional();

/** Карточка чата: консоли нужны только id подтверждённой компании и кандидата. */
export const chatCardSchema = z.looseObject({
  company: z
    .looseObject({ confirmed: linkedCompany, candidate: linkedCompany })
    .nullable()
    .optional(),
});

// Итоги действий.

export const replyResultSchema = z.looseObject({ result: z.enum(['sent', 'duplicate']) });
export const returnResultSchema = z.looseObject({
  result: z.enum(['returned', 'returned_answering', 'already_bot']),
  /** Скольким сообщениям клиента бот ответит после возврата (реализация бота). */
  resumed: countSchema.optional(),
});
export const runStartedSchema = z.looseObject({ runId: idSchema });
export const approvedSchema = z.looseObject({ result: z.literal('approved') });
export const rejectedSchema = z.looseObject({ result: z.literal('rejected') });
export const savedSchema = z.looseObject({
  result: z.literal('saved'),
  checksTotal: countSchema,
  checksFailed: countSchema,
});
export const testSentSchema = z.looseObject({
  result: z.literal('sent'),
  sentTo: z.string().max(254),
  at: isoTimeSchema,
});
export const blockedSchema = z.looseObject({ result: z.literal('blocked') });
export const clearedSchema = z.looseObject({
  result: z.literal('cleared'),
  wasRequestedVia: z.string().max(40).nullable().optional(),
});
export const importedSchema = z.looseObject({
  added: countSchema,
  existing: countSchema,
  invalid: z.array(z.string().max(200)).max(20),
  invalidMore: countSchema,
});

export type LeadsSummary = z.output<typeof leadsSummarySchema>;
export type LeadsSpend = z.output<typeof leadsSpendSchema>;
export type Prices = z.output<typeof pricesSchema>;
export type Digest = z.output<typeof digestSchema>;
export type WaStatus = z.output<typeof waStatusSchema>;
export type WaAttention = z.output<typeof waAttentionSchema>;
export type WaSpend = z.output<typeof waSpendSchema>;
export type CompanyLinks = z.output<typeof companyLinksSchema>;
export type ChatCard = z.output<typeof chatCardSchema>;
export type ListData = z.output<typeof listSchema>;
export type ObjectData = z.output<typeof anyObjectSchema>;
