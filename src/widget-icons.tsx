// Inline SVG icons for the widget. Source: Google's Material Symbols
// (Apache 2.0 — https://fonts.google.com/icons), traced into SVG paths so
// we don't need to fetch the font from a CDN at runtime. SECURITY_MODEL.md
// restricts outbound calls; pulling fonts off Google's CDN would add a new
// destination that the security review pack would have to enumerate.
//
// Each component is a 24×24 viewBox <svg>; size is controlled by font-size
// on a wrapping element (we set width/height to "1em" so they scale with
// surrounding type).

import type { CSSProperties } from "react";

type IconProps = {
  size?: number | string;
  className?: string;
  style?: CSSProperties;
};

const baseProps = (props: IconProps) => ({
  width: props.size ?? "1em",
  height: props.size ?? "1em",
  viewBox: "0 0 24 24",
  fill: "currentColor",
  className: props.className,
  style: props.style,
  xmlns: "http://www.w3.org/2000/svg",
  "aria-hidden": true,
});

export function IconRemove(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M19 13H5v-2h14v2z" />
    </svg>
  );
}

export function IconSettings(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M19.14 12.94c.04-.31.06-.63.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.61-.22l-2.39.96a7.03 7.03 0 0 0-1.62-.94l-.36-2.54A.5.5 0 0 0 13.9 2h-3.84a.5.5 0 0 0-.49.42l-.36 2.54c-.59.24-1.13.55-1.62.94l-2.39-.96a.5.5 0 0 0-.61.22L2.67 8.48a.5.5 0 0 0 .12.64L4.82 10.7c-.04.31-.06.63-.06.94s.02.63.06.94L2.79 14.16a.5.5 0 0 0-.12.64l1.92 3.32c.14.24.43.34.68.22l2.39-.96c.49.39 1.03.7 1.62.94l.36 2.54c.04.24.25.42.49.42h3.84c.24 0 .45-.18.49-.42l.36-2.54c.59-.24 1.13-.55 1.62-.94l2.39.96c.25.12.54.02.68-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58zM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" />
    </svg>
  );
}

export function IconClose(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z" />
    </svg>
  );
}

export function IconSchema(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M22 11V3h-7v3H9V3H2v8h7V8h2v10h4v3h7v-8h-7v3h-2V8h2v3h7zM7 9H4V5h3v4zm10 6h3v4h-3v-4zm0-10h3v4h-3V5z" />
    </svg>
  );
}

export function IconProgress(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M12 4V2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10h-2c0 4.41-3.59 8-8 8s-8-3.59-8-8 3.59-8 8-8z" />
    </svg>
  );
}

export function IconCopy(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z" />
    </svg>
  );
}

export function IconError(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
    </svg>
  );
}

export function IconExpandLess(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M12 8 6 14l1.41 1.41L12 10.83l4.59 4.58L18 14z" />
    </svg>
  );
}

export function IconSpeed(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M20.38 8.57 19.62 6c-.4-1.37-1.65-2.37-3.07-2.43L11.5 3.4 13 1.9l-.71-.71L8 5.5l4.29 4.29L13 9.07l-1.5-1.5 5.05.17c.74.03 1.39.55 1.6 1.27l.76 2.57H22V11h-1.62zM2 13v6h2v-6c0-.55.45-1 1-1h12c.55 0 1 .45 1 1v6h2v-6c0-1.66-1.34-3-3-3H5c-1.66 0-3 1.34-3 3z" />
    </svg>
  );
}

export function IconCheckCircle(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z" />
    </svg>
  );
}

export function IconExpandMore(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M16.59 8.59 12 13.17 7.41 8.59 6 10l6 6 6-6-1.41-1.41z" />
    </svg>
  );
}

export function IconCheck(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z" />
    </svg>
  );
}

export function IconRefresh(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z" />
    </svg>
  );
}

export function IconInfo(props: IconProps) {
  return (
    <svg {...baseProps(props)}>
      <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" />
    </svg>
  );
}
