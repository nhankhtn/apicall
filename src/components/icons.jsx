const base = { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true };

const make = (children) => (props) => (
  <svg {...base} {...props}>
    {children}
  </svg>
);

export const IconCollection = make(
  <>
    <path d="M2 4.5 8 2l6 2.5v7L8 14l-6-2.5z" />
    <path d="M2 4.5 8 7l6-2.5M8 7v7" />
  </>,
);
export const IconFolder = make(<path d="M1.5 4a1 1 0 0 1 1-1h3.6l1.5 1.6h5.9a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" />);
export const IconEnv = make(
  <>
    <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
    <path d="M5 6h6M5 8.5h6M5 11h3.5" />
  </>,
);
export const IconGlobe = make(
  <>
    <circle cx="8" cy="8" r="6" />
    <path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" />
  </>,
);
export const IconPlay = make(<path d="M5 3.5v9l7-4.5z" fill="currentColor" stroke="none" />);
export const IconStop = make(<rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none" />);
export const IconPlus = make(<path d="M8 3v10M3 8h10" />);
export const IconMore = make(
  <>
    <circle cx="3.5" cy="8" r="1.1" fill="currentColor" />
    <circle cx="8" cy="8" r="1.1" fill="currentColor" />
    <circle cx="12.5" cy="8" r="1.1" fill="currentColor" />
  </>,
);
export const IconImport = make(<path d="M8 2v8m0 0L5 7m3 3 3-3M3 11v2h10v-2" />);
export const IconExport = make(<path d="M8 10V2m0 0L5 5m3-3 3 3M3 11v2h10v-2" />);
export const IconCaret = make(<path d="M6 4l4 4-4 4" />);
export const IconGear = make(
  <>
    <circle cx="8" cy="8" r="2.2" />
    <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
  </>,
);
export const IconX = make(<path d="M4 4l8 8M12 4l-8 8" />);
export const IconCheck = make(<path d="M3 8.5 6.5 12 13 4.5" />);
export const IconAlert = make(
  <>
    <path d="M8 2 14.5 13.5h-13z" />
    <path d="M8 6.5v3M8 11.6v.1" />
  </>,
);
export const IconCopy = make(
  <>
    <rect x="5" y="5" width="8.5" height="8.5" rx="1.2" />
    <path d="M10.5 5V3.2a.7.7 0 0 0-.7-.7H3.2a.7.7 0 0 0-.7.7v6.6c0 .4.3.7.7.7H5" />
  </>,
);
export const IconSearch = make(
  <>
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3 3" />
  </>,
);
export const IconLogo = (props) => (
  <span className="logo-mark glass" aria-hidden>
    <svg viewBox="0 0 32 32" {...props}>
      <path d="M11 7.5v17l14-8.5z" fill="currentColor" />
    </svg>
  </span>
);
export const IconSun = make(
  <>
    <circle cx="8" cy="8" r="3" />
    <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
  </>,
);
export const IconMoon = make(<path d="M13.2 9.6A5.5 5.5 0 0 1 6.4 2.8a5.5 5.5 0 1 0 6.8 6.8z" />);
export const IconCode = make(<path d="M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5M9 3l-2 10" />);
export const IconCaretDown = make(<path d="M4 6l4 4 4-4" />);
export const IconHistory = make(
  <>
    <path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9L2.5 5.7" />
    <path d="M2.5 2.5v3.2h3.2M8 5v3.2l2.2 1.4" />
  </>,
);
export const IconCookie = make(
  <>
    <path d="M13.5 8.3A5.5 5.5 0 1 1 7.7 2.5a2 2 0 0 0 2.3 2.3 2 2 0 0 0 2.2 2.2 2 2 0 0 0 1.3 1.3z" />
    <circle cx="6" cy="7" r=".6" fill="currentColor" />
    <circle cx="9" cy="10.5" r=".6" fill="currentColor" />
    <circle cx="5.8" cy="10.2" r=".6" fill="currentColor" />
  </>,
);
export const IconLock = make(
  <>
    <rect x="3" y="7" width="10" height="7" rx="1.5" />
    <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
  </>,
);
export const IconExample = make(
  <>
    <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
    <path d="M5 6h6M5 8.5h6M5 11h3" />
  </>,
);
