import { heroui } from "@heroui/react";

/**
 * One brand ramp drives both themes. Light picks the 600 step so text on a filled
 * button stays white; dark picks 500 because the darker steps disappear against a
 * near-black surface.
 */
const brand = {
  50: "#eff6ff",
  100: "#dbeafe",
  200: "#bfdbfe",
  300: "#93c5fd",
  400: "#60a5fa",
  500: "#3b82f6",
  600: "#2563eb",
  700: "#1d4ed8",
  800: "#1e40af",
  900: "#1e3a8a",
};

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,jsx}",
    // HeroUI keeps its component class strings in @heroui/theme, which has to be
    // scanned or every component renders unstyled. It is a transitive dependency,
    // so npm may hoist it beside @heroui/react or nest it underneath; both
    // locations are listed because a glob that matches nothing is simply ignored.
    "./node_modules/@heroui/theme/dist/**/*.{js,ts,jsx,tsx}",
    "./node_modules/@heroui/react/node_modules/@heroui/theme/dist/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "Segoe UI",
          "Roboto",
          "sans-serif",
        ],
        mono: [
          "ui-monospace",
          "SFMono-Regular",
          "JetBrains Mono",
          "Consolas",
          "monospace",
        ],
      },
      keyframes: {
        "caret-blink": { "50%": { opacity: "0" } },
        "typing-hop": {
          "0%, 60%, 100%": { opacity: "0.35", transform: "translateY(0)" },
          "30%": { opacity: "1", transform: "translateY(-2px)" },
        },
      },
      animation: {
        "caret-blink": "caret-blink 1s step-end infinite",
        "typing-hop": "typing-hop 1.15s ease-in-out infinite",
      },
    },
  },
  plugins: [
    heroui({
      addCommonColors: true,
      layout: {
        radius: { small: "6px", medium: "10px", large: "14px" },
        fontSize: {
          tiny: "0.72rem",
          small: "0.82rem",
          medium: "0.92rem",
          large: "1.05rem",
        },
      },
      themes: {
        light: {
          colors: {
            background: "#f5f7fb",
            foreground: "#0f172a",
            divider: "#e2e8f0",
            focus: brand[600],
            content1: "#ffffff",
            content2: "#f1f5f9",
            content3: "#e2e8f0",
            content4: "#cbd5e1",
            primary: { ...brand, DEFAULT: brand[600], foreground: "#ffffff" },
            secondary: { DEFAULT: "#7c3aed", foreground: "#ffffff" },
            success: { DEFAULT: "#16a34a", foreground: "#ffffff" },
            warning: { DEFAULT: "#d97706", foreground: "#ffffff" },
            danger: { DEFAULT: "#dc2626", foreground: "#ffffff" },
          },
        },
        dark: {
          colors: {
            background: "#0a0f1c",
            foreground: "#e2e8f0",
            divider: "#1e293b",
            focus: brand[500],
            content1: "#111827",
            content2: "#1a2233",
            content3: "#243044",
            content4: "#2f3d55",
            primary: { ...brand, DEFAULT: brand[500], foreground: "#ffffff" },
            secondary: { DEFAULT: "#a78bfa", foreground: "#1e1b4b" },
            success: { DEFAULT: "#22c55e", foreground: "#052e16" },
            warning: { DEFAULT: "#f59e0b", foreground: "#451a03" },
            danger: { DEFAULT: "#f87171", foreground: "#450a0a" },
          },
        },
      },
    }),
  ],
};
