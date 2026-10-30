// Один набор контурных значков 16px, штрих 1.5 (app-screens §9.4). Цвет — currentColor.

interface IconProps {
  readonly size?: number;
}

function Svg({ size = 16, children }: IconProps & { readonly children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const IconHome = (p: IconProps) => (
  <Svg {...p}><path d="M2.5 7.2 8 2.8l5.5 4.4V13a.5.5 0 0 1-.5.5H9.5V10h-3v3.5H3a.5.5 0 0 1-.5-.5Z" /></Svg>
);
export const IconChats = (p: IconProps) => (
  <Svg {...p}><path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" /></Svg>
);
export const IconCompanies = (p: IconProps) => (
  <Svg {...p}><path d="M3 13.5V3.5h6v10M9 6.5h4v7M5 6h2M5 8.5h2M5 11h2M11 9h0.5M11 11.5h0.5M1.5 13.5h13" /></Svg>
);
export const IconLetters = (p: IconProps) => (
  <Svg {...p}><path d="M2 4h12v8.5H2zM2.5 4.5 8 9l5.5-4.5" /></Svg>
);
export const IconSearch = (p: IconProps) => (
  <Svg {...p}><circle cx="7" cy="7" r="4.25" /><path d="m10.2 10.2 3.3 3.3" /></Svg>
);
export const IconHistory = (p: IconProps) => (
  <Svg {...p}><path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.2h2.2M8 5v3.2l2 1.3" /></Svg>
);
export const IconBell = (p: IconProps) => (
  <Svg {...p}><path d="M4 11V7.5a4 4 0 0 1 8 0V11l1 1.5H3zM6.5 14h3" /></Svg>
);
export const IconSystem = (p: IconProps) => (
  <Svg {...p}><path d="M2.5 4.5h7M12.5 4.5h1M2.5 11.5h1M6.5 11.5h7" /><circle cx="11" cy="4.5" r="1.5" /><circle cx="5" cy="11.5" r="1.5" /></Svg>
);
export const IconMore = (p: IconProps) => (
  <Svg {...p}><circle cx="3.5" cy="8" r="0.6" /><circle cx="8" cy="8" r="0.6" /><circle cx="12.5" cy="8" r="0.6" /></Svg>
);
export const IconBack = (p: IconProps) => (
  <Svg {...p}><path d="M10 3 5 8l5 5" /></Svg>
);
export const IconPhone = (p: IconProps) => (
  <Svg {...p}><path d="M5.5 2.5 4 2.6c-.8.1-1.4.8-1.3 1.6.6 4.6 4.5 8.5 9.1 9.1.8.1 1.5-.5 1.6-1.3l.1-1.5-2.8-1.2-1.3 1.3a7.5 7.5 0 0 1-3.3-3.3L7.4 6 6.2 3.2Z" /></Svg>
);
export const IconExternal = (p: IconProps) => (
  <Svg {...p}><path d="M9 3h4v4M13 3 7.5 8.5M11.5 9.5V13h-8.5V4.5H6.5" /></Svg>
);
export const IconRefresh = (p: IconProps) => (
  <Svg {...p}><path d="M13 3.5v3h-3M3 12.5v-3h3M12.6 6.5A5 5 0 0 0 4 4.8M3.4 9.5A5 5 0 0 0 12 11.2" /></Svg>
);
export const IconSend = (p: IconProps) => (
  <Svg {...p}><path d="M2.5 8h10M8.5 4l4 4-4 4" /></Svg>
);
export const IconCheck = (p: IconProps) => (
  <Svg {...p}><path d="m3 8.5 3.2 3L13 4.5" /></Svg>
);
export const IconCross = (p: IconProps) => (
  <Svg {...p}><path d="m4 4 8 8M12 4l-8 8" /></Svg>
);
