import type { Config } from "tailwindcss";

// Tokens live in src/styles/tokens.css as RGB channels; this wrapper lets
// Tailwind alpha modifiers (`border-border/60`) generate real CSS.
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: token("bg"),
        surface: token("surface"),
        "surface-2": token("surface-2"),
        "surface-3": token("surface-3"),
        border: token("border"),
        "border-strong": token("border-strong"),
        text: token("text"),
        "text-dim": token("text-dim"),
        "text-faint": token("text-faint"),
        accent: token("accent"),
        "accent-ink": token("accent-ink"),
        pos: token("pos"),
        neg: token("neg"),
        warn: token("warn"),
        info: token("info"),
        cat: {
          1: token("cat-1"),
          2: token("cat-2"),
          3: token("cat-3"),
          4: token("cat-4"),
          5: token("cat-5"),
          6: token("cat-6"),
          7: token("cat-7"),
          8: token("cat-8")
        }
      },
      fontFamily: {
        mono: ["var(--font-mono)", "ui-monospace", "monospace"],
        sans: ["var(--font-sans)", "system-ui", "sans-serif"]
      },
      // Named type scale. Nothing below 11px: the old 10px uppercase labels
      // were unreadable. Use these instead of text-[NNpx].
      fontSize: {
        label: ["11px", { lineHeight: "16px" }],
        meta: ["12px", { lineHeight: "18px" }],
        body: ["13px", { lineHeight: "20px" }],
        lead: ["15px", { lineHeight: "22px" }],
        title: ["20px", { lineHeight: "28px" }],
        stat: ["28px", { lineHeight: "32px" }],
        hero: ["40px", { lineHeight: "44px" }]
      },
      letterSpacing: {
        label: "var(--track-wide)"
      },
      spacing: {
        "shell-top": "var(--shell-top)",
        "shell-bottom": "var(--shell-bottom)",
        rail: "var(--rail-w)"
      },
      maxWidth: {
        prose: "72ch"
      },
      transitionDuration: {
        DEFAULT: "120ms"
      }
    }
  },
  plugins: []
};

export default config;
