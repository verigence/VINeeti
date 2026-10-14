import type { ReactNode } from "react";

export type IconName =
  | "home" | "car" | "bookings" | "approvals" | "dashboards" | "analytics" | "upload" | "recon" | "whatsapp" | "admin" | "audit"
  | "menu" | "close" | "bell" | "logout" | "key" | "plus" | "search" | "external" | "copy" | "refresh" | "download"
  | "eye" | "eye-off" | "warning" | "check" | "chevron" | "back" | "file" | "clock" | "info" | "filter" | "more" | "phone" | "offline" | "share" | "payments" | "owner" | "master" | "dayend" | "up" | "down";

const PATHS: Record<IconName, ReactNode> = {
  home: <path d="M4 11.5 12 5l8 6.5V20h-5.5v-5h-5v5H4z" />,
  car: (
    <>
      <path d="M4 16v-3.2l2-5.3h12l2 5.3V16" />
      <path d="M3 16h18v3H3z" />
      <circle cx="7.5" cy="15" r=".6" />
      <circle cx="16.5" cy="15" r=".6" />
    </>
  ),
  bookings: (
    <>
      <rect x="5" y="4" width="14" height="17" rx="1.5" />
      <path d="M9 4V2.8h6V4M8.5 10h7M8.5 14h7M8.5 18h4" />
    </>
  ),
  approvals: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.3 12.3 2.6 2.6 4.8-5.4" />
    </>
  ),
  dashboards: <path d="M4 20V10M10 20V4M16 20v-7M21 20H3" />,
  analytics: <path d="M3 17l5-6 4 4 5-7 4 4M3 21h18" />,
  upload: <path d="M12 16V4m0 0L7.5 8.5M12 4l4.5 4.5M4 16v4h16v-4" />,
  recon: (
    <>
      <path d="M12 4v16M5 20h14M6 8h12" />
      <path d="M6 8 3.5 14a2.7 2.7 0 0 0 5 0zM18 8l-2.5 6a2.7 2.7 0 0 0 5 0z" />
    </>
  ),
  whatsapp: <path d="M4 19.5 5.2 15.5A7.8 7.8 0 1 1 8.3 18.6z" />,
  admin: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8" />
    </>
  ),
  audit: (
    <>
      <path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3L4.5 9" />
      <path d="M4.5 4.5V9H9M12 8v4.3l3 1.7" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="m6 6 12 12M18 6 6 18" />,
  bell: <path d="M6 17V11a6 6 0 1 1 12 0v6l1.5 2h-15zM10 21h4" />,
  logout: <path d="M10 4H5v16h5M14 8l4 4-4 4M18 12H9" />,
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="m11 12 8-8M16 7l2.5 2.5M14 9l1.5 1.5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  eye: (
    <>
      <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6Z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  "eye-off": (
    <>
      <path d="M10.6 6.2A9.9 9.9 0 0 1 12 6c6.4 0 10 6 10 6a17.7 17.7 0 0 1-3.3 3.8M6.5 7.8A17.6 17.6 0 0 0 2 12s3.6 6 10 6a9.7 9.7 0 0 0 3.9-.8" />
      <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
      <path d="M3 3l18 18" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 4 4" />
    </>
  ),
  external: <path d="M13 5h6v6M19 5l-8 8M10 6H5v13h13v-5" />,
  copy: (
    <>
      <rect x="8" y="8" width="11" height="12" rx="1.5" />
      <path d="M5 16V5.5A1.5 1.5 0 0 1 6.5 4H15" />
    </>
  ),
  refresh: <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3L19.5 9M19.5 4.5V9H15" />,
  download: <path d="M12 4v12m0 0-4.5-4.5M12 16l4.5-4.5M4 20h16" />,
  warning: (
    <>
      <path d="M12 4 2.5 20h19z" />
      <path d="M12 10v4.5M12 17.2v.3" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7" />,
  chevron: <path d="m9 6 6 6-6 6" />,
  back: <path d="M15 6l-6 6 6 6" />,
  file: (
    <>
      <path d="M7 3h7l4 4v14H7z" />
      <path d="M14 3v4h4" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  filter: <path d="M4 5.5h16l-6 7V18l-4 1.5v-7z" />,
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="18.5" cy="12" r="1.4" />
    </>
  ),
  phone: (
    <>
      <rect x="7" y="3" width="10" height="18" rx="2" />
      <path d="M11 17.8h2" />
    </>
  ),
  offline: (
    <>
      <path d="M3 9.5a13 13 0 0 1 4.5-2.7M10.8 5.6A13 13 0 0 1 21 9.5M6.5 13a8 8 0 0 1 3-1.9M14.5 11.2a8 8 0 0 1 3 1.8M10 16.5a3.5 3.5 0 0 1 4 0" />
      <path d="M12 19.5v.300M4 4l16 16" />
    </>
  ),
  share: <path d="M12 15V4m0 0L8 8m4-4 4 4M6 12v8h12v-8" />,
  payments: (
    <>
      <rect x="3" y="6.5" width="18" height="11" rx="1.5" />
      <circle cx="12" cy="12" r="2.6" />
      <path d="M6.5 9.5v.3M17.5 14.2v.3" />
    </>
  ),
  owner: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.500 12 21.500 12 18 18.500 12 18.500 2.500 12 2.500 12z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  master: <path d="M12 3.5 3.500 8 12 12.500 20.500 8zM3.500 12 12 16.500 20.500 12M3.500 16 12 20.500 20.500 16" />,
  dayend: (
    <>
      <rect x="4" y="5" width="16" height="15" rx="1.5" />
      <path d="M8 3v4M16 3v4M4 10h16M8.500 15l2.500 2.500 4.500-5" />
    </>
  ),
  up: <path d="m6 14 6-6 6 6" />,
  down: <path d="m6 10 6 6 6-6" />,
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5M12 7.5v.3" />
    </>
  ),
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}
