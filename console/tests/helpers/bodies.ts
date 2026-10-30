// Формы ответов консоли, которые тесты читают по полям (остальное проверяется toEqual/toMatchObject).

export interface SpendTotalBody {
  readonly usd: number | null;
  readonly tokens: number;
  readonly unpricedTokens: number;
  readonly calls: number;
  readonly notCountedCalls: number;
}

interface SideSpendBody {
  readonly today: SpendTotalBody;
  readonly month: SpendTotalBody;
}

export interface HomeBody {
  readonly mode: {
    readonly bot: { readonly code: string; readonly text: string };
    readonly leads: {
      readonly code: string;
      readonly text: string;
      readonly testAddress: string | null;
    };
    readonly lettersNote: string;
  };
  readonly botStatus: Readonly<Record<string, unknown>>;
  readonly attention: {
    readonly handoffs: readonly { readonly id: number; readonly seen: boolean }[];
    readonly newHandoffs: number;
  };
  readonly leadsSummary: Readonly<Record<string, unknown>>;
  readonly spend: {
    readonly pricesAsOf: string | null;
    readonly bot: SideSpendBody;
    readonly leads: SideSpendBody;
    readonly botCalls: unknown;
    readonly leadsBudget: unknown;
  };
  readonly afterLetter: {
    readonly items: readonly Readonly<Record<string, unknown>>[];
    readonly newCount: number;
    readonly note: string;
    readonly linksTruncated: boolean;
  };
}

export interface ItemsBody {
  readonly items: readonly Readonly<Record<string, unknown>>[];
}

export interface ClientCardBody {
  readonly chat: { readonly chat: { readonly name: string } };
  readonly company: {
    readonly id: number;
    readonly confirmed: boolean;
    readonly label: string;
    readonly leads: unknown;
  } | null;
}

export interface CompanyCardBody {
  readonly company: unknown;
  readonly chats: { readonly items?: readonly unknown[] };
}

export interface SystemBody {
  readonly botStatus: { readonly apiCalls: unknown };
  readonly leadsSummary: { readonly testSends: unknown };
}

export interface SpendReportBody {
  readonly from: string;
  readonly to: string;
  readonly prices: Readonly<Record<string, unknown>>;
  readonly bot: { readonly total: SpendTotalBody };
  readonly leads: {
    readonly days: readonly { readonly day: string; readonly usd: number | null }[];
    readonly total: SpendTotalBody;
  };
}

export interface AuditBody {
  readonly total: number;
  readonly items: readonly { readonly action: string; readonly at: string }[];
}

export interface SessionsBody {
  readonly items: readonly {
    readonly id: number;
    readonly user: string;
    readonly current: boolean;
  }[];
}
