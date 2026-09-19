import tailwindcssAnimate from "tailwindcss-animate";

/**
 * Enterprise Agents — design tokens.
 *
 * The system is Swiss-technical rather than soft-SaaS. Three rules produce most of
 * the look, and every component follows them:
 *
 *   1. Consistent rounded corners: compact controls and softer panel outlines.
 *   2. Nothing static casts a shadow. Separation comes from 1px rules and space.
 *      A shadow means "this floats above the page" and is reserved for overlays.
 *   3. Grey is achromatic. #0057d2 is the only hue that ever appears, so colour
 *      always carries meaning instead of decorating.
 *
 *   4. One typeface. Aileron sets everything — body, labels, numerals, code. A
 *      second family would carry hierarchy that type size, weight and colour are
 *      already carrying, so it would only add noise.
 *
 * Hierarchy is therefore carried by type and rules: tracked-out uppercase
 * micro-labels for structure, light-weight tabular numerals for measurements.
 *
 * Colours are declared the shadcn/ui way: every token is a CSS variable holding
 * bare HSL channels, resolved here through `hsl(var(--x) / <alpha-value>)`. That
 * indirection is what lets `bg-primary/[0.06]` work while the light and dark
 * palettes swap underneath in styles.css.
 */

/** Channel-only HSL, so Tailwind can inject an alpha value. */
const token = (name) => `hsl(var(${name}) / <alpha-value>)`;

/** A full numeric ramp, for tokens that are addressed by step as well as by name. */
const ramp = (prefix, steps) =>
  Object.fromEntries(steps.map((step) => [step, token(`--${prefix}-${step}`)]));

const RAMP_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];
const STATE_STEPS = [400, 500, 600];

/**
 * One typeface: Aileron.
 *
 * Body copy, micro-labels, measurements and code are all set in it. The fallbacks
 * are the faces Aileron was drawn against — it is a neo-grotesque in the Helvetica
 * line — so a machine without the webfont shifts metrics slightly instead of
 * changing character.
 */
const AILERON = [
  "Aileron",
  "Helvetica Neue",
  "Helvetica",
  "Segoe UI Variable Text",
  "Segoe UI",
  "system-ui",
  "-apple-system",
  "Arial",
  "sans-serif",
];

/**
 * The type scale. Seven steps, named by the job they do rather than by size, so
 * `text-small` means one thing on every screen.
 *
 * Nothing in src/ may set a size any other way. The arbitrary values this replaced
 * — 9, 10, 11, 12, 13, 15, 26 and 34px, all reached through `text-[Npx]` — had
 * drifted into fourteen effective sizes doing seven jobs, with 9/10 and 11/12/13
 * pairs that no one could tell apart on screen but which every new component had to
 * choose between.
 */
const SCALE = {
  /** Uppercase micro-labels, keyboard hints, badges. Never body copy. */
  micro: ["0.6875rem", { lineHeight: "1rem" }],
  /** Dense metadata, table cells, code. */
  tiny: ["0.75rem", { lineHeight: "1rem" }],
  /** Body copy. The default reading size of the console. */
  small: ["0.875rem", { lineHeight: "1.375rem" }],
  /** Emphasised body, form inputs, the chat composer. */
  medium: ["0.9375rem", { lineHeight: "1.5rem" }],
  /** Panel and section headings. */
  large: ["1rem", { lineHeight: "1.5rem" }],
  /** Dialog and empty-state titles. */
  title: ["1.5rem", { lineHeight: "2rem" }],
  /** Page h1 and the dashboard metrics. The largest type in the product. */
  display: ["1.875rem", { lineHeight: "1.2" }],
};

/**
 * Tailwind's own size names, aliased onto the same seven steps.
 *
 * This is the enforcement. `text-sm` and `text-2xl` still resolve, but they cannot
 * introduce an eighth size, so a shadcn component pasted in from the docs lands on
 * the scale instead of beside it.
 */
const SCALE_ALIASES = {
  xs: SCALE.tiny,
  sm: SCALE.small,
  base: SCALE.medium,
  lg: SCALE.large,
  xl: SCALE.title,
  "2xl": SCALE.display,
  "3xl": SCALE.display,
  "4xl": SCALE.display,
  "5xl": SCALE.display,
  "6xl": SCALE.display,
  "7xl": SCALE.display,
  "8xl": SCALE.display,
  "9xl": SCALE.display,
};

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  darkMode: "class",
  theme: {
    /**
     * `fontSize` and `fontWeight` replace Tailwind's defaults rather than extending
     * them. Both are closed sets here: the point is that there is no size or weight
     * class in the framework that escapes the scale.
     */
    fontSize: { ...SCALE, ...SCALE_ALIASES },

    /**
     * The weight ladder, pinned to weights Aileron actually ships.
     *
     * Aileron has no 500. Leaving `font-medium` at 500 would hand the browser a
     * synthesised weight — it fakes it by smearing the 400 outline — which reads as
     * a blurred label at 10px, the size most of this interface's labels are set at.
     * So `medium` is 600 and `semibold` is 700, and every class below resolves to a
     * real woff2 file imported in src/main.jsx.
     *
     * Four weights carry the whole product:
     *   300  light      measurements, the display numerals
     *   400  normal     body copy
     *   600  medium     micro-labels, emphasis
     *   700  semibold   strong labels, headings
     */
    fontWeight: {
      thin: "300",
      extralight: "300",
      light: "300",
      normal: "400",
      medium: "600",
      semibold: "700",
      bold: "700",
      extrabold: "700",
      black: "700",
    },

    extend: {
      colors: {
        /* --- shadcn/ui contract. Every generated component speaks these. --- */
        border: token("--border"),
        input: token("--input"),
        ring: token("--ring"),
        background: token("--background"),
        foreground: token("--foreground"),
        primary: {
          ...ramp("brand", RAMP_STEPS),
          DEFAULT: token("--primary"),
          foreground: token("--primary-foreground"),
        },
        secondary: {
          ...ramp("brand", RAMP_STEPS),
          DEFAULT: token("--secondary"),
          foreground: token("--secondary-foreground"),
        },
        destructive: {
          ...ramp("danger", STATE_STEPS),
          DEFAULT: token("--destructive"),
          foreground: token("--destructive-foreground"),
        },
        muted: {
          DEFAULT: token("--muted"),
          foreground: token("--muted-foreground"),
        },
        accent: {
          DEFAULT: token("--accent"),
          foreground: token("--accent-foreground"),
        },
        popover: {
          DEFAULT: token("--popover"),
          foreground: token("--popover-foreground"),
        },
        card: {
          DEFAULT: token("--card"),
          foreground: token("--card-foreground"),
        },

        /*
         * --- The console's own vocabulary. ---
         *
         * These names predate the shadcn migration and appear in several thousand
         * class attributes across the pages. They are kept as first-class tokens
         * pointing at the same variables the shadcn tokens use, so `bg-content2`
         * and `bg-muted` cannot drift apart. `divider` and `content1..4` describe
         * surfaces by depth, which is more useful in a dense console than the
         * single `card` step shadcn ships with.
         */
        divider: token("--border"),
        /** The modal / drawer wash. Always used with an alpha: `bg-scrim/50`. */
        scrim: token("--scrim"),
        content1: token("--card"),
        content2: token("--content2"),
        content3: token("--content3"),
        content4: token("--content4"),
        focus: token("--ring"),
        default: {
          ...ramp("default", [50, 100, 200, 300, 400, 500, 600, 700, 800, 900]),
          DEFAULT: token("--default-200"),
          foreground: token("--foreground"),
        },
        success: {
          ...ramp("success", STATE_STEPS),
          DEFAULT: token("--success"),
          foreground: token("--success-foreground"),
        },
        warning: {
          ...ramp("warning", STATE_STEPS),
          DEFAULT: token("--warning"),
          foreground: token("--warning-foreground"),
        },
        danger: {
          ...ramp("danger", STATE_STEPS),
          DEFAULT: token("--destructive"),
          foreground: token("--destructive-foreground"),
        },
        brand: ramp("brand", RAMP_STEPS),
      },
      /**
       * Shared radius scale: 6px details, 8px controls, and 12px panels.
       */
      borderRadius: {
        none: "0px",
        sm: "calc(var(--radius) - 6px)",
        DEFAULT: "calc(var(--radius) - 4px)",
        md: "calc(var(--radius) - 4px)",
        lg: "calc(var(--radius) - 2px)",
        xl: "var(--radius)",
        "2xl": "calc(var(--radius) + 4px)",
        "3xl": "calc(var(--radius) + 8px)",
        full: "9999px",
      },
      /**
       * One family, reached by two names.
       *
       * `font-mono` was never really about code in this system — it set every
       * structural label, breadcrumb, badge and ID in the interface, which is why
       * the product used to read in two voices. Both names now resolve to Aileron,
       * so `font-mono` is a no-op that is kept because it appears in dozens of
       * class strings and removing it would say nothing new.
       *
       * Code and JSON are set in Aileron too, and lean on `tabular-nums` (applied
       * on body in styles.css) to keep columns of figures aligned. If a real
       * monospace is ever wanted back for code fences alone, change `mono` here and
       * nothing else: only genuine <pre> and editor surfaces still ask for it.
       */
      fontFamily: {
        sans: AILERON,
        mono: AILERON,
      },
      /**
       * Only overlays. There is deliberately no `card` or `panel` elevation: a
       * surface that sits on the page is separated by a rule, not by a blur.
       */
      boxShadow: {
        overlay:
          "0 24px 64px -16px rgb(9 9 11 / 28%), 0 2px 8px -2px rgb(9 9 11 / 12%)",
        drawer:
          "0 0 0 1px rgb(9 9 11 / 8%), -24px 0 48px -24px rgb(9 9 11 / 24%)",
        // A focus ring drawn as a shadow, for elements that already own their border.
        focus: "0 0 0 3px rgb(0 87 210 / 18%)",
      },
      /**
       * Two tracking values, both retuned for Aileron.
       *
       * `label` is what makes a 10px uppercase run legible — without it the caps
       * collide. It is the one place this system spends letter-spacing generously.
       *
       * `display` is gentler than the -0.03em Inter wanted: Aileron is a narrower
       * grotesque with tighter sidebearings, so the same negative value closed the
       * large numerals up into each other.
       */
      letterSpacing: {
        label: "0.14em",
        display: "-0.018em",
      },
      keyframes: {
        "caret-blink": { "50%": { opacity: "0" } },
        "typing-hop": {
          "0%, 60%, 100%": { opacity: "0.35", transform: "translateY(0)" },
          "30%": { opacity: "1", transform: "translateY(-2px)" },
        },
        // Sweeps a highlight across a skeleton. Animating background position
        // rather than opacity stops every placeholder on screen from pulsing in
        // unison, which reads as a broken screen rather than a loading one.
        shimmer: {
          "0%": { backgroundPosition: "100% 50%" },
          "100%": { backgroundPosition: "0% 50%" },
        },
        "toast-in": {
          from: { opacity: "0", transform: "translateX(8px)" },
          to: { opacity: "1", transform: "translateX(0)" },
        },
        // Radix drives these through data-state, for the dialog, popover,
        // select and tooltip surfaces.
        "overlay-in": { from: { opacity: "0" }, to: { opacity: "1" } },
        "content-in": {
          from: { opacity: "0", transform: "translateY(-2px) scale(0.99)" },
          to: { opacity: "1", transform: "translateY(0) scale(1)" },
        },
      },
      animation: {
        "caret-blink": "caret-blink 1s step-end infinite",
        "typing-hop": "typing-hop 1.15s ease-in-out infinite",
        shimmer: "shimmer 2s ease-in-out infinite",
        "toast-in": "toast-in 140ms cubic-bezier(0.16,1,0.3,1)",
        "overlay-in": "overlay-in 120ms ease-out",
        "content-in": "content-in 140ms cubic-bezier(0.16,1,0.3,1)",
      },
    },
  },
  plugins: [tailwindcssAnimate],
};
