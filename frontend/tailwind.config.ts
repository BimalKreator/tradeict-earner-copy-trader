import type { Config } from "tailwindcss";

export default {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "#080808",
        primary: "#0A84FF",
        glass: "rgba(10, 132, 255, 0.1)",
        glassBorder: "rgba(10, 132, 255, 0.2)",
      },
    },
  },
} satisfies Config;
