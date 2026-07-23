import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: "var(--color-surface)",
          muted: "var(--color-surface-muted)",
        },
        ink: {
          DEFAULT: "var(--color-text)",
          muted: "var(--color-text-muted)",
        },
        line: "var(--color-border)",
        accent: "var(--color-accent)",
        status: {
          warning: "var(--color-status-warning)",
          danger: "var(--color-status-danger)",
          success: "var(--color-status-success)",
        },
        macro: {
          kcal: "var(--color-macro-kcal)",
          protein: "var(--color-macro-protein)",
          fat: "var(--color-macro-fat)",
          carbs: "var(--color-macro-carbs)",
        },
      },
    },
  },
  plugins: [],
};

export default config;
