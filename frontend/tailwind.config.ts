import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        brand: {
          primary: "var(--color-brand-primary)",
          secondary: "var(--color-brand-secondary)",
          accent: "var(--color-brand-accent)",
          surface: "var(--color-brand-surface)",
          "surface-alt": "var(--color-brand-surface-alt)",
          outline: "var(--color-brand-outline)"
        }
      },
      fontFamily: {
        sans: ["var(--font-family-sans)", "system-ui", "sans-serif"],
        mono: ["var(--font-family-mono)", "monospace"]
      }
    }
  },
  plugins: []
};

export default config;
