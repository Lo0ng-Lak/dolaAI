/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          950: "#1a2030",
          900: "#222a3c",
          850: "#2a3348",
          800: "#343e56",
          700: "#41506b",
          600: "#55637f",
        },
        line: "#4a5670",
        mint: "#3ef0d0",
        mintDim: "#1aa890",
        violet: "#9b7dff",
      },
      fontFamily: {
        sans: ["Inter", "Segoe UI", "system-ui", "sans-serif"],
        mono: ["IBM Plex Mono", "Consolas", "monospace"],
      },
      boxShadow: {
        panel: "0 0 0 1px rgba(255,255,255,0.08), 0 14px 36px rgba(0,0,0,0.18)",
        mint: "0 8px 24px rgba(62, 240, 208, 0.22)",
      },
    },
  },
  plugins: [],
};
