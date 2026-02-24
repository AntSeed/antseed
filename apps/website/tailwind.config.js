/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: {
          DEFAULT: '#0a0e14',
          2: '#0d1117',
          3: '#161B22',
        },
        accent: {
          DEFAULT: '#3dffa2',
          bright: '#6affba',
          dim: '#2ecc82',
        },
        text: {
          DEFAULT: '#e6edf3',
          dim: '#8b949e',
          muted: '#484F58',
        },
        border: '#21262D',
      },
      fontFamily: {
        sans: ['Space Grotesk', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Fira Code', 'monospace'],
      },
      keyframes: {
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-12px)' },
        },
        fadeUp: {
          from: { opacity: '0', transform: 'translateY(20px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        float: 'float 6s ease-in-out infinite',
        'fade-up-1': 'fadeUp 0.8s ease forwards 0.3s',
        'fade-up-2': 'fadeUp 0.8s ease forwards 0.5s',
        'fade-up-3': 'fadeUp 0.8s ease forwards 0.7s',
        'fade-up-4': 'fadeUp 0.8s ease forwards 0.9s',
        'fade-up-5': 'fadeUp 0.8s ease forwards 1.1s',
      },
    },
  },
  plugins: [],
}
