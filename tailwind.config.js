/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#0f172a",
          900: "#1e293b",
          850: "#334155",
          800: "#475569",
          700: "#64748b",
          600: "#94a3b8",
        },
        paper: "#ffffff",
        canvas: "#eef2f7",
        line: "#dce3ee",
        mint: "#0d9488",
        mintDim: "#0f766e",
        mintSoft: "#ccfbf1",
        violet: "#4f46e5",
      },
      fontFamily: {
        sans: ["Inter", "Segoe UI", "system-ui", "sans-serif"],
        mono: ["IBM Plex Mono", "Consolas", "monospace"],
      },
      boxShadow: {
        panel: "0 1px 2px rgba(15,23,42,0.04), 0 10px 28px rgba(15,23,42,0.06)",
        mint: "0 8px 20px rgba(13, 148, 136, 0.22)",
      },
    },
  },
  plugins: [],
};
