import React from "react";

const Svg = ({ size = 22, children, ...p }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" {...p}>
    {children}
  </svg>
);
const mk = (d) => (props) => <Svg {...props}><path d={d} /></Svg>;

export const HomeIcon = mk("M4 10.5L12 4l8 6.5V20H4zM10 20v-5h4v5");
export const TreeIcon = mk("M10 3h4v4h-4zM3 17h4v4H3zM17 17h4v4h-4zM12 7v5M5 17v-5h14v5");
export const ShapesIcon = mk("M4 7h9M17 7h3M4 17h3M11 17h9M15 4v6M9 14v6");
export const GearIcon = mk("M12 8.5a3.5 3.5 0 100 7 3.5 3.5 0 000-7zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9L7 7M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1");
export const DoubleChevron = mk("M5 12h14M13 6l6 6-6 6");
export const PanelIcon = mk("M3 5h18v14H3zM9 5v14");
export const RefreshIcon = mk("M20 12a8 8 0 11-2.3-5.7M20 4v5h-5");
export const SearchIcon = mk("M10.5 4a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM20 20l-4.8-4.8");
export const AssetIcon = mk("M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5");
export const PlusCircle = mk("M12 3a9 9 0 100 18 9 9 0 000-18zM12 8v8M8 12h8");
export const FilterIcon = mk("M3 4h18l-7 8v7l-4 2v-9z");
export const ExternalIcon = mk("M14 4h6v6M20 4l-9 9M18 14v6H4V6h6");
export const BackIcon = mk("M15 6l-6 6 6 6");
export const ChevronDown = mk("M6 9l6 6 6-6");
export const ChevronRight = mk("M9 6l6 6-6 6");
export const UserIcon = mk("M12 4a4 4 0 100 8 4 4 0 000-8zM4 20c0-4 3.5-6 8-6s8 2 8 6z");
export const MailIcon = mk("M3 6h18v12H3zM3 7l9 7 9-7");
export const LinkIcon = mk("M12 4c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 7v10c0 1.7 3.6 3 8 3s8-1.3 8-3V7M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3");
export const BookmarkIcon = mk("M5 20v-8M12 20V5M19 20v-9");
export const BackupIcon = mk("M7 18a4.5 4.5 0 01-.6-8.96A6 6 0 0118 10a4 4 0 01-1 8H7zM12 12v5M9.5 14.5L12 12l2.5 2.5");
export const UploadIcon = mk("M12 20V7M6 13l6-6 6 6M5 3h14");
export const ClipboardIcon = mk("M7 4h10v17H7zM10 2h4v4h-4zM10 11h4M10 15h4");
export const GridIcon = mk("M12 3l9 5-9 5-9-5zM3 13l9 5 9-5");
export const PlugIcon = mk("M6 17v-6a6 6 0 1112 0v6l1.5 2h-15zM10 21h4");
export const InfoIcon = mk("M12 3a9 9 0 100 18 9 9 0 000-18zM12 11v6M12 7.5v.5");
export const SunIcon = mk("M12 8a4 4 0 100 8 4 4 0 000-8zM12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4");
export const MoonIcon = mk("M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z");
export const DotsIcon = (p) => (
  <Svg {...p} strokeWidth="3"><path d="M5 12h.01M12 12h.01M19 12h.01" /></Svg>
);
export const FxIcon = mk("M3 12h4l2.5-6 4 12 2.5-6H21");
export const AlertDiamond = (p) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="10" fill="currentColor" stroke="none" />
    <path d="M12 7v6M12 16v1" stroke="#fff" />
  </Svg>
);
export const EditIcon = mk("M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z");
export const WarnTriangle = (p) => (
  <Svg {...p}>
    <path d="M12 3l10 18H2z" fill="currentColor" />
    <path d="M12 9v5M12 17v1" stroke="#fff" />
  </Svg>
);


export const EmptyArt = () => (
  <svg width="340" height="190" viewBox="0 0 340 190" fill="none">
    {Array.from({ length: 6 }).map((_, r) =>
      Array.from({ length: 22 }).map((_, c) => (
        <rect key={`${r}-${c}`} x={10 + c * 14} y={20 + r * 14} width="3" height="3" style={{ fill: "var(--art-dot)" }} opacity={(r + c) % 3 ? 0.5 : 1} />
      ))
    )}
    <rect x="95" y="40" width="150" height="100" rx="18" style={{ fill: "var(--art-card)", stroke: "var(--art-line)" }} />
    <circle cx="165" cy="85" r="24" strokeWidth="5" style={{ stroke: "var(--art-mag)" }} />
    <path d="M183 103l22 22" strokeWidth="6" strokeLinecap="round" style={{ stroke: "var(--art-mag)" }} />
    <ellipse cx="170" cy="160" rx="75" ry="6" style={{ fill: "var(--art-shadow)" }} />
  </svg>
);
export const CheckIcon = mk("M5 12.5l4.5 4.5L19 7.5");
export const PlusIcon = mk("M12 5v14M5 12h14");
