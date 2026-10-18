/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{js,ts,jsx,tsx,mdx}"],
  theme: {
    extend: {
      colors: {
        ink: "#17211d",
        muted: "#68746d",
        canvas: "#f7f8f5",
        line: "#e5e9e3",
        moss: "#2b7051",
        mint: "#e8f4ec",
      },
      fontFamily: {
        sans: ["Arial", "Helvetica", "sans-serif"],
      },
      boxShadow: {
        soft: "0 12px 40px rgba(23, 33, 29, 0.07)",
      },
    },
  },
  plugins: [],
};
