import { heroui } from "@heroui/react";

/**
 * A warm graphite ramp keeps interaction states restrained. Copper is reserved for
 * brand moments and status accents instead of washing whole screens in color.
 */
const brand = {
  50: "#f3f2ef",
  100: "#e7e5df",
  200: "#d1cec6",
  300: "#b2aea5",
  400: "#8b867d",
  500: "#68635c",
  600: "#4c4944",
  700: "#393632",
  800: "#2b2926",
  900: "#211f1d",
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
          "Anthropic Sans",
          "Helvetica Neue",
          "Arial",
          "ui-sans-serif",
          "system-ui",
          "Segoe UI",
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
        radius: { small: "5px", medium: "8px", large: "12px" },
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
            background: "#f7f6f2",
            foreground: "#292724",
            divider: "#dfddd7",
            focus: "#9a4f36",
            content1: "#fffefa",
            content2: "#f1f0eb",
            content3: "#e7e5df",
            content4: "#d6d3cb",
            primary: { ...brand, DEFAULT: brand[800], foreground: "#fffefa" },
            secondary: { DEFAULT: "#b65f42", foreground: "#ffffff" },
            success: { DEFAULT: "#397557", foreground: "#ffffff" },
            warning: { DEFAULT: "#a86724", foreground: "#ffffff" },
            danger: { DEFAULT: "#b5443c", foreground: "#ffffff" },
          },
        },
        dark: {
          colors: {
            background: "#191816",
            foreground: "#ece9e2",
            divider: "#393733",
            focus: "#d17a59",
            content1: "#22211e",
            content2: "#2a2925",
            content3: "#34322e",
            content4: "#45423c",
            primary: { ...brand, DEFAULT: "#e4e0d7", foreground: "#211f1d" },
            secondary: { DEFAULT: "#d17a59", foreground: "#211713" },
            success: { DEFAULT: "#68a17d", foreground: "#13271b" },
            warning: { DEFAULT: "#d39a52", foreground: "#2c1c0c" },
            danger: { DEFAULT: "#df746b", foreground: "#32100d" },
          },
        },
      },
    }),
  ],
};
