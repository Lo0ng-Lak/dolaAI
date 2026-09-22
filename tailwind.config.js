/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#f4f7fb",
          900: "#e6ebf3",
          850: "#c3ccd8",
          800: "#9aa6b8",
          700: "#8b95a7",
          600: "#6b7588",
          card: "#12161e",
          nest: "#1a1f2a",
        },
        paper: "#12161e",
        canvas: "#0a0c10",
        line: "#2a3140",
        mint: "#3ef0d0",
        mintDim: "#22d3b5",
        mintSoft: "#15352f",
        violet: "#8b7cff",
      },
      fontFamily: {
        sans: ["Inter", "Segoe UI", "system-ui", "sans-serif"],
        mono: ["IBM Plex Mono", "Consolas", "monospace"],
      },
      boxShadow: {
        panel: "0 0 0 1px rgba(255,255,255,0.03), 0 16px 40px rgba(0,0,0,0.35)",
        mint: "0 10px 28px rgba(62, 240, 208, 0.22)",
      },
    },
  },
  plugins: [],
};
